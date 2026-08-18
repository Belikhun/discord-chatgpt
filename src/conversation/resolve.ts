import { DMChannel, type ChatInputCommandInteraction } from "discord.js";
import config from "../config";
import { env } from "../env";
import { ChatConversation } from "./ChatConversation";
import { getConversation, setConversation } from "./store";
import { applyMemorySummaryToConversation } from "./memorySummary";
import type { ConversationChannel, ConversationMode } from "./types";

const {
	WAKEUP_KEYWORDS,
	SYSTEM_ROLE_CHANNEL,
	SYSTEM_ROLE_SERVER,
	SYSTEM_ROLE_SERVER_ASSISTANT,
	SYSTEM_ROLE_MODEL,
	SYSTEM_ROLE_CHAT,
	SYSTEM_ROLE_ASSISTANT,
	MODEL_DEFAULT,
	NICKNAME_DEFAULT
} = env;

export function applyMemorySummary(conversation: ChatConversation): void {
	const guildId = conversation?.channel?.guild?.id;
	if (!guildId)
		return;

	const summaries = config.get<Record<string, string>>("memorySummaries", {});
	const summary = summaries?.[guildId];
	if (!summary)
		return;

	applyMemorySummaryToConversation(conversation, summary);
}

export function resolveConversation(channel: ConversationChannel, { modeOverride }: { modeOverride?: ConversationMode } = {}): ChatConversation {
	const existing = getConversation(channel.id);
	if (existing)
		return existing;

	const model = config.get<string>(`model.${channel.id}`, MODEL_DEFAULT);
	const mode = modeOverride ?? config.get<ConversationMode>(`mode.${channel.id}`, (channel instanceof DMChannel) ? "assistant" : "chat");
	const reasoningEffort = config.get<string>(`reasoning.${channel.id}`, "medium") || "medium";

	let instructions: string;

	if (mode === "chat") {
		if (typeof SYSTEM_ROLE_CHANNEL[channel.id] !== "undefined") {
			instructions = SYSTEM_ROLE_CHANNEL[channel.id] as string;
		} else if (channel.guild && typeof SYSTEM_ROLE_SERVER[channel.guild.id] !== "undefined") {
			instructions = SYSTEM_ROLE_SERVER[channel.guild.id] as string;
		} else if (typeof SYSTEM_ROLE_MODEL[model] !== "undefined") {
			instructions = SYSTEM_ROLE_MODEL[model] as string;
		} else {
			instructions = SYSTEM_ROLE_CHAT;
		}
	} else {
		if (channel.guild && typeof SYSTEM_ROLE_SERVER_ASSISTANT[channel.guild.id] !== "undefined") {
			instructions = SYSTEM_ROLE_SERVER_ASSISTANT[channel.guild.id] as string;
		} else {
			instructions = SYSTEM_ROLE_ASSISTANT;
		}
	}

	const nicknames = config.get<Record<string, string>>("nicknames", {});
	const conversation = new ChatConversation(channel, model, instructions, mode, {
		nickname: nicknames[channel.guild?.id as string] || NICKNAME_DEFAULT,
		reasoningEffort
	});

	conversation.conversationWakeupKeywords = WAKEUP_KEYWORDS;
	applyMemorySummary(conversation);
	setConversation(channel.id, conversation);

	return conversation;
}

/**
 * Resolve (or create) an assistant-mode conversation for a slash command
 * interaction. Used by the personal-app `/b` command, which may run in
 * channels the bot cannot access directly (bot DMs, group DMs, servers where
 * only the user installed the app), so a lightweight channel facade is used
 * when the real channel object is unavailable.
 */
export function resolveAssistantConversation(interaction: ChatInputCommandInteraction, { model = null, thinking = null }: { model?: string | null; thinking?: string | null } = {}): ChatConversation {
	const channelId = interaction.channelId;

	// Share the channel's conversation (and history) only when that channel
	// already behaves as an assistant channel (DMs, or /mode assistant).
	// Otherwise keep /b history under a dedicated key so a chat-mode guild
	// channel is neither clobbered nor switched into assistant mode.
	const expectedMode = config.get<ConversationMode>(`mode.${channelId}`, interaction.guild ? "chat" : "assistant");
	let key = (expectedMode === "assistant") ? channelId : `b:${channelId}`;
	let conversation = getConversation(key);

	if (conversation && conversation.mode !== "assistant") {
		key = `b:${channelId}`;
		conversation = getConversation(key);
	}

	if (conversation) {
		if (model)
			conversation.model = model;

		if (thinking)
			conversation.reasoningEffort = thinking;

		return conversation;
	}

	const channel: ConversationChannel = (interaction.channel as any) || {
		id: channelId,
		name: `${interaction.user.displayName}'s chat`,
		guild: interaction.guild || null
	};

	const conversationModel = model || config.get<string>(`model.${channelId}`, MODEL_DEFAULT);
	const reasoningEffort = thinking || config.get<string>(`reasoning.${channelId}`, "medium") || "medium";

	let instructions: string;
	if (interaction.guild && typeof SYSTEM_ROLE_SERVER_ASSISTANT[interaction.guild.id] !== "undefined") {
		instructions = SYSTEM_ROLE_SERVER_ASSISTANT[interaction.guild.id] as string;
	} else {
		instructions = SYSTEM_ROLE_ASSISTANT;
	}

	const nicknames = config.get<Record<string, string>>("nicknames", {});
	conversation = new ChatConversation(channel, conversationModel, instructions, "assistant", {
		nickname: nicknames[interaction.guild?.id as string] || NICKNAME_DEFAULT,
		reasoningEffort
	});

	conversation.conversationWakeupKeywords = WAKEUP_KEYWORDS;
	applyMemorySummary(conversation);
	setConversation(key, conversation);

	return conversation;
}
