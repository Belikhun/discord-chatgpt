import { scope } from "../logger";
import type { ToolCall, ToolDefinition, ToolResultItem } from "../ai/types";
import type { Tool, ToolContext } from "./types";
import { getUserInfoTool, reactMessageTool, forwardMessageTool } from "./users";
import { getServerInfoTool, listEmojisTool, fetchRecentMessagesTool, searchMessagesTool } from "./server";
import { listConversationsTool, searchConversationHistoryTool } from "./conversations";
import { listMemoriesTool, createMemoryTool } from "./memory";
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
	listMemoriesTool,
	createMemoryTool,
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

/** All executable tools, including permission-gated ones. */
const allTools = new Map<string, Tool>();

for (const tool of [...baseTools, ...moderationTools])
	allTools.set(tool.definition.name, tool);

/**
 * Get the tool definitions offered to the model for the given context.
 * Moderation tools are only offered when the bot has full moderation access.
 */
export async function getToolDefinitions(context: ToolContext = {}): Promise<ToolDefinition[]> {
	const definitions = baseTools.map((tool) => tool.definition);

	const capabilities = await getModerationCapabilities(context);
	if (capabilities.fullModerationAccess)
		definitions.push(...moderationTools.map((tool) => tool.definition));

	return definitions;
}

function wrapToolOutput(callId: string, payload: Record<string, any>): ToolResultItem {
	return {
		kind: "tool_result",
		callId,
		output: JSON.stringify(payload)
	};
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

	const tool = allTools.get(name);
	if (!tool) {
		return wrapToolOutput(id, {
			ok: false,
			error: `Unknown tool: ${name}`
		});
	}

	try {
		return wrapToolOutput(id, await tool.execute(args, context));
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

export async function runToolCalls(toolCalls: ToolCall[], context: ToolContext = {}): Promise<ToolResultItem[]> {
	const results: ToolResultItem[] = [];

	for (const call of toolCalls) {
		results.push(await runToolCall(call, context));
	}

	return results;
}
