import type { ChatMessage, HistoryEntry } from "../ai/types";
import { extractItemTexts } from "../ai/registry";
import type { ChatConversation } from "./ChatConversation";

const PREFIX = "Memory summary:";

/**
 * Insert (or replace) the developer "Memory summary" entry at the head of a
 * conversation's history.
 */
export function applyMemorySummaryToConversation(conversation: ChatConversation, summary: string): void {
	if (!conversation || !summary)
		return;

	const history: HistoryEntry[] = Array.isArray(conversation.history) ? conversation.history : [];
	const text = `${PREFIX}\n${summary}`;

	const isSummaryEntry = (entry: HistoryEntry) => {
		if (!entry || entry.item.kind !== "message" || entry.item.role !== "developer")
			return false;

		const content = extractItemTexts(entry.item).join("\n");
		return content.startsWith(PREFIX);
	};

	const existingIndex = history.findIndex(isSummaryEntry);
	if (existingIndex >= 0)
		history.splice(existingIndex, 1);

	const message: ChatMessage = {
		kind: "message",
		role: "developer",
		content: [{ type: "text", text }]
	};

	history.unshift({
		item: message,
		timestamp: Date.now()
	});

	conversation.history = history;
}
