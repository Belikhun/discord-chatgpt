import { extractItemTexts } from "../ai/registry";
import type { HistoryEntry } from "../ai/types";
import { listConversations as listStoredConversations } from "../conversation/store";
import { resolveGuild } from "./resolve";
import type { Tool, ToolContext } from "./types";

export const listConversationsTool: Tool = {
	definition: {
		name: "list_conversations",
		description: "List stored chat conversations for other channels (in-memory history).",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				guildId: {
					type: ["string", "null"],
					description: "Guild ID to filter. If null, use the current server when available."
				},
				includeCurrent: {
					type: ["boolean", "null"],
					description: "Include the current channel in results. Default false."
				},
				limit: {
					type: ["number", "null"],
					description: "Maximum number of conversations to return."
				}
			},
			required: ["guildId", "includeCurrent", "limit"],
			additionalProperties: false
		}
	},

	async execute({ guildId, includeCurrent, limit }, context: ToolContext) {
		const guild = await resolveGuild(guildId, context);
		if (guildId && !guild) {
			return { ok: false, error: "Không tìm thấy máy chủ hoặc máy chủ không khả dụng trong ngữ cảnh hiện tại." };
		}

		const currentChannelId = context?.conversation?.channel?.id || null;
		const includeSelf = Boolean(includeCurrent);
		const max = Math.max(1, Math.min(100, Math.floor(limit ?? 50)));

		const items = listStoredConversations()
			.filter((conversation) => {
				if (!conversation?.channel)
					return false;
				if (!includeSelf && conversation.channel.id === currentChannelId)
					return false;
				if (guild?.id && conversation.channel.guild?.id !== guild.id)
					return false;
				return true;
			})
			.map((conversation) => {
				const history: HistoryEntry[] = Array.isArray(conversation.history) ? conversation.history : [];
				const lastItem = history.length ? history[history.length - 1] : null;
				return {
					channelId: conversation.channel.id,
					channelName: conversation.channel.name || null,
					guildId: conversation.channel.guild?.id || null,
					mode: conversation.mode,
					model: conversation.model,
					historyCount: history.length,
					lastMessageAt: lastItem?.timestamp ?? null,
					processing: Boolean(conversation.processing)
				};
			})
			.sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));

		return { ok: true, count: items.length, items: items.slice(0, max) };
	}
};

export const searchConversationHistoryTool: Tool = {
	definition: {
		name: "search_conversation_history",
		description: "Search in-memory ChatConversation history across other channels.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				guildId: {
					type: ["string", "null"],
					description: "Guild ID to filter. If null, use the current server when available."
				},
				channelIds: {
					type: ["array", "null"],
					items: { type: "string" },
					description: "Optional list of channel IDs to search. If null, search all stored channels."
				},
				query: {
					type: "string",
					description: "Search text to match in stored conversation history."
				},
				limit: {
					type: ["number", "null"],
					description: "Maximum number of matched entries to return."
				},
				maxPerChannel: {
					type: ["number", "null"],
					description: "Maximum results per channel."
				},
				includeCurrent: {
					type: ["boolean", "null"],
					description: "Include the current channel in search. Default false."
				}
			},
			required: ["guildId", "channelIds", "query", "limit", "maxPerChannel", "includeCurrent"],
			additionalProperties: false
		}
	},

	async execute({
		guildId,
		channelIds,
		query,
		limit,
		maxPerChannel,
		includeCurrent
	}, context: ToolContext) {
		const guild = await resolveGuild(guildId, context);
		if (guildId && !guild) {
			return { ok: false, error: "Guild not found or not available in this context." };
		}

		const needle = (query || "").trim();
		if (!needle)
			return { ok: false, error: "Search query cannot be empty." };

		const currentChannelId = context?.conversation?.channel?.id || null;
		const includeSelf = Boolean(includeCurrent);
		const maxTotal = Math.max(1, Math.min(200, Math.floor(limit ?? 50)));
		const maxEach = Math.max(1, Math.min(50, Math.floor(maxPerChannel ?? 10)));
		const allowedIds = Array.isArray(channelIds) ? new Set(channelIds.filter(Boolean)) : null;
		const lowerNeedle = needle.toLowerCase();

		const results: Record<string, any>[] = [];
		for (const conversation of listStoredConversations()) {
			if (!conversation?.channel)
				continue;
			if (!includeSelf && conversation.channel.id === currentChannelId)
				continue;
			if (guild?.id && conversation.channel.guild?.id !== guild.id)
				continue;
			if (allowedIds && !allowedIds.has(conversation.channel.id))
				continue;

			const history: HistoryEntry[] = Array.isArray(conversation.history) ? conversation.history : [];
			let perChannelCount = 0;
			for (const entry of history) {
				if (perChannelCount >= maxEach || results.length >= maxTotal)
					break;

				const texts = extractItemTexts(entry.item);
				for (const text of texts) {
					if (perChannelCount >= maxEach || results.length >= maxTotal)
						break;

					if (typeof text !== "string")
						continue;

					const lowerText = text.toLowerCase();
					if (!lowerText.includes(lowerNeedle))
						continue;

					const excerpt = text.length > 500 ? `${text.slice(0, 497)}...` : text;
					results.push({
						channelId: conversation.channel.id,
						channelName: conversation.channel.name || null,
						guildId: conversation.channel.guild?.id || null,
						role: (entry.item.kind === "message") ? entry.item.role : ((entry.item as any).item?.role || null),
						timestamp: entry.timestamp ?? null,
						text: excerpt
					});
					perChannelCount += 1;
				}
			}
			if (results.length >= maxTotal)
				break;
		}

		return { ok: true, count: results.length, items: results };
	}
};
