/**
 * Shared in-memory store for active ChatConversation instances.
 */
export const conversationStore = new Map();

export function getConversation(channelId) {
	return conversationStore.get(channelId) || null;
}

export function setConversation(channelId, conversation) {
	if (!channelId)
		return;

	if (conversation) {
		conversationStore.set(channelId, conversation);
		return;
	}

	conversationStore.delete(channelId);
}

export function listConversations() {
	return Array.from(conversationStore.values());
}
