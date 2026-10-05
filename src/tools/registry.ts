import { scope } from "../logger";
import type { ToolCall, ToolDefinition, ToolResultItem } from "../ai/types";
import { DEFAULT_TOOL_TIMEOUT_MS, MAX_TOOL_OUTPUT_CHARS } from "./types";
import type { Tool, ToolContext, ToolSource } from "./types";
import { getUserInfoTool, reactMessageTool, forwardMessageTool } from "./users";
import { getServerInfoTool, listEmojisTool, fetchRecentMessagesTool, searchMessagesTool } from "./server";
import { listConversationsTool, searchConversationHistoryTool } from "./conversations";
import { memoryTools } from "./memory";
import { fetchWebpageTool } from "./web";
import { minecraftWikiSearchTool, minecraftWikiSearchContentTool, minecraftWikiReadContentTool } from "./minecraftWiki";
import { moderationTools, getModerationCapabilities } from "./moderation";

export { buildDeveloperMessages } from "./moderation";

const log = scope("chat-tool");

/** Tools always offered to the model. */
const baseTools: Tool[] = [
	getUserInfoTool,
	reactMessageTool,
	forwardMessageTool,
	getServerInfoTool,
	...memoryTools,
	listConversationsTool,
	searchConversationHistoryTool,
	listEmojisTool,
	fetchRecentMessagesTool,
	searchMessagesTool,
	fetchWebpageTool,
	minecraftWikiSearchTool,
	minecraftWikiSearchContentTool,
	minecraftWikiReadContentTool
];

/** Built-in tools that can be dispatched without a per-request toolset. */
const builtinTools = new Map<string, Tool>();

for (const tool of [...baseTools, ...moderationTools])
	builtinTools.set(tool.definition.name, tool);

/** Built-in tools, with moderation tools only when the bot has full moderation access. */
const builtinSource: ToolSource = {
	id: "builtin",

	async tools(context) {
		const capabilities = await getModerationCapabilities(context);

		return capabilities.fullModerationAccess
			? [...baseTools, ...moderationTools]
			: baseTools;
	}
};

const sources: ToolSource[] = [builtinSource];

/**
 * Register an extra tool source (an MCP client, for one). Sources are asked
 * in registration order and a later tool never shadows an earlier name.
 */
export function registerToolSource(source: ToolSource): void {
	const existing = sources.findIndex((entry) => entry.id === source.id);

	if (existing >= 0)
		sources.splice(existing, 1, source);
	else
		sources.push(source);
}

/**
 * Resolve every tool available in this context, and remember the result on
 * the context so dispatch only ever runs a tool that was actually offered.
 */
export async function getTools(context: ToolContext = {}): Promise<Tool[]> {
	const toolset = new Map<string, Tool>();

	for (const source of sources) {
		let tools: Tool[];

		try {
			tools = await source.tools(context);
		} catch (err: any) {
			// One broken source (an unreachable MCP server) must not take the
			// built-in tools down with it.
			log.warn(`Tool source ${source.id} failed: ${err?.message || err}`);
			continue;
		}

		for (const tool of tools) {
			if (toolset.has(tool.definition.name)) {
				log.warn(`Tool ${tool.definition.name} from ${source.id} shadows an existing tool, skipping.`);
				continue;
			}

			toolset.set(tool.definition.name, tool);
		}
	}

	context.toolset = toolset;
	return [...toolset.values()];
}

/**
 * Get the tool definitions offered to the model for the given context.
 * Moderation tools are only offered when the bot has full moderation access.
 */
export async function getToolDefinitions(context: ToolContext = {}): Promise<ToolDefinition[]> {
	return (await getTools(context)).map((tool) => tool.definition);
}

/** Look a tool up by name: the per-request toolset when there is one, else the built-ins. */
export function findTool(name: string, context: ToolContext = {}): Tool | undefined {
	return context.toolset?.get(name) ?? builtinTools.get(name);
}

function truncateOutput(output: string): string {
	if (output.length <= MAX_TOOL_OUTPUT_CHARS)
		return output;

	return `${output.slice(0, MAX_TOOL_OUTPUT_CHARS)}… [truncated ${output.length - MAX_TOOL_OUTPUT_CHARS} characters]`;
}

function wrapToolOutput(callId: string, payload: Record<string, any>): ToolResultItem {
	return {
		kind: "tool_result",
		callId,
		output: truncateOutput(JSON.stringify(payload))
	};
}

function withTimeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;

	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`Tool ${name} timed out after ${Math.round(ms / 1000)}s`)), ms);
	});

	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function runToolCall(call: ToolCall, context: ToolContext = {}): Promise<ToolResultItem> {
	const { name, id } = call;
	let args: Record<string, any> = {};

	try {
		args = (call?.arguments) ? JSON.parse(call.arguments) : {};
	} catch (err: any) {
		return wrapToolOutput(id, {
			ok: false,
			error: `Invalid tool arguments JSON: ${err.message}`
		});
	}

	const tool = findTool(name, context);
	if (!tool) {
		return wrapToolOutput(id, {
			ok: false,
			error: `Unknown tool: ${name}`
		});
	}

	try {
		const result = await withTimeout(tool.execute(args, context), tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS, name);
		return wrapToolOutput(id, result);
	} catch (err: any) {
		const detail = {
			name,
			arguments: args,
			error: err?.message || String(err),
			stack: err?.stack || null
		};
		log.error(`Tool ${name} failed: ${detail.error}`);
		log.error(detail);
		return wrapToolOutput(id, {
			ok: false,
			error: err?.message || String(err)
		});
	}
}

/**
 * Run a batch of tool calls concurrently. Results come back in call order,
 * which is what the providers pair outputs against.
 */
export async function runToolCalls(toolCalls: ToolCall[], context: ToolContext = {}): Promise<ToolResultItem[]> {
	return await Promise.all(toolCalls.map((call) => runToolCall(call, context)));
}
