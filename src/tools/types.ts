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
}

/** A chat tool: its model-facing definition plus its executor. */
export interface Tool {
	definition: ToolDefinition;
	execute(args: Record<string, any>, context: ToolContext): Promise<Record<string, any>>;
}
