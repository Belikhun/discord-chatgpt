import type { ChatConversation } from "./ChatConversation";
import { clearHistory } from "../stores/history";

/**
 * Shared in-memory store for active ChatConversation instances.
 */
export const conversationStore = new Map<string, ChatConversation>();

export function getConversation(channelId: string): ChatConversation | null {
	return conversationStore.get(channelId) || null;
}

export function setConversation(channelId: string, conversation: ChatConversation | null): void {
	if (!channelId)
		return;

	if (conversation) {
		conversationStore.set(channelId, conversation);
		return;
	}

	// Clearing a conversation (/clear, or a model or mode change) also forgets
	// what is on disk, or the next message would restore it straight back.
	conversationStore.delete(channelId);
	clearHistory(channelId);
}

export function listConversations(): ChatConversation[] {
	return Array.from(conversationStore.values());
}
