import type { ChatConversation } from "./ChatConversation";

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

	conversationStore.delete(channelId);
}

export function listConversations(): ChatConversation[] {
	return Array.from(conversationStore.values());
}
