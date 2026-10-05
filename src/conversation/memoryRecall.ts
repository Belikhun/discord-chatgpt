import { env } from "../env";
import { pinnedMemories, searchMemories, type Memory } from "../stores/memory";
import { memoryViewer } from "../tools/memory";
import type { ToolContext } from "../tools/types";
import { registerContextSource } from "./contextSources";

/** How many memories are recalled per request on top of the pinned ones. */
const RECALL_LIMIT = env.CONTEXT?.RECALL_LIMIT ?? 6;

function line(memory: Memory): string {
	const scope = memory.scope.kind === "user"
		? `user ${memory.scope.id.split(":")[1]}`
		: memory.scope.kind === "guild" ? "server" : memory.scope.kind;

	return `- [${memory.id} · ${scope}] ${memory.content.replace(/\s+/g, " ")}`;
}

/**
 * The text a request is recalled against: the triggering message, or failing
 * that the last user message in history.
 */
function recallQuery(context: ToolContext): string {
	const content = context.message?.content?.trim();
	if (content)
		return content;

	const history = context.conversation?.history ?? [];

	for (let i = history.length - 1; i >= 0; i--) {
		const item = history[i]!.item;

		if (item.kind === "message" && item.role === "user") {
			const text = item.content.find((part) => part.type === "text");
			if (text && text.type === "text")
				return text.text.slice(0, 1000);
		}
	}

	return "";
}

registerContextSource({
	id: "memory",

	async build(context) {
		const viewer = memoryViewer(context);
		const pinned = pinnedMemories(viewer);
		const query = recallQuery(context);
		const hits = query
			? await searchMemories(query, viewer, RECALL_LIMIT)
			: [];

		const seen = new Set(pinned.map((memory) => memory.id));
		const recalled = hits.map((hit) => hit.memory).filter((memory) => !seen.has(memory.id));

		if (pinned.length === 0 && recalled.length === 0)
			return null;

		const sections = ["Memories (saved earlier with memory_save; update or forget them by id when they turn out wrong):"];

		if (pinned.length > 0)
			sections.push("Always keep in mind:", ...pinned.map(line));

		if (recalled.length > 0)
			sections.push("Possibly relevant to this message:", ...recalled.map(line));

		return sections.join("\n");
	}
});
