import { scope } from "../logger";
import type { ChatMessage } from "../ai/types";
import type { ToolContext } from "../tools/types";

const log = scope("context");

/**
 * Something that contributes a developer note to every request: recalled
 * memories, an MCP server's instructions, the moderation profile. Notes are
 * rebuilt per request and never stored in history, so they are always current
 * and never pile up.
 */
export interface ContextSource {
	id: string;
	build(context: ToolContext): Promise<string | null>;
}

const sources: ContextSource[] = [];

export function registerContextSource(source: ContextSource): void {
	const existing = sources.findIndex((entry) => entry.id === source.id);

	if (existing >= 0)
		sources.splice(existing, 1, source);
	else
		sources.push(source);
}

/** Every source's note for this request, as developer messages, in registration order. */
export async function buildContextMessages(context: ToolContext): Promise<ChatMessage[]> {
	const notes = await Promise.all(sources.map(async (source) => {
		try {
			return await source.build(context);
		} catch (err: any) {
			log.warn(`Context source ${source.id} failed: ${err?.message || err}`);
			return null;
		}
	}));

	return notes
		.filter((note): note is string => !!note?.trim())
		.map((text) => ({ kind: "message", role: "developer", content: [{ type: "text", text }] }));
}
