import type { ToolDefinition } from "../ai/types";
import type { ChatConversation } from "../conversation/ChatConversation";
import type { IncomingMessage } from "../conversation/types";
import type { ModerationCapabilities } from "./moderation/capabilities";

/**
 * Runtime context passed to tool executions: the conversation the call came
 * from and (when triggered by a message) the message itself.
 */
export interface ToolContext {
	conversation?: ChatConversation;
	message?: IncomingMessage | null;
	forceRespond?: boolean;
	/** Per-request cache of resolved moderation capabilities. */
	moderationCapabilities?: ModerationCapabilities;

	/**
	 * The tools offered for this request, by name, filled in by
	 * `getToolDefinitions`. Dispatch resolves against this first, so a tool
	 * that only exists for this channel (an MCP server enabled here) can be
	 * executed, and one that is not offered here cannot.
	 */
	toolset?: Map<string, Tool>;
}

/** A chat tool: its model-facing definition plus its executor. */
export interface Tool {
	definition: ToolDefinition;
	execute(args: Record<string, any>, context: ToolContext): Promise<Record<string, any>>;

	/** Longest a single call may run before it is abandoned. Defaults to {@link DEFAULT_TOOL_TIMEOUT_MS}. */
	timeoutMs?: number;

	/** Where the tool comes from, for logs and the tool-call UI ("builtin", "mcp:luna", …). */
	source?: string;
}

/**
 * A provider of tools. Built-in tools are one source and every enabled MCP
 * server is another; sources are asked per request so availability can depend
 * on the guild, channel and the bot's permissions there.
 */
export interface ToolSource {
	id: string;
	tools(context: ToolContext): Promise<Tool[]>;
}

/** How long a tool call may run unless the tool says otherwise. */
export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

/**
 * Longest tool output fed back to the model, in characters. Anything past it
 * is cut and marked, so one oversized web page cannot eat the context window.
 */
export const MAX_TOOL_OUTPUT_CHARS = 24_000;
