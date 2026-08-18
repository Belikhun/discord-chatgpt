import { ChannelType } from "discord.js";
import { scope } from "../logger";
import { discord } from "../discord/client";
import { ALL_EMOJIS } from "../emojis";
import { resolveChannel, resolveGuild } from "./resolve";
import type { Tool, ToolContext } from "./types";

const log = scope("chat-tool");

export const getServerInfoTool: Tool = {
	definition: {
		name: "get_server_info",
		description: "Get information about a Discord server (guild), including channels and roles if requested.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				guildId: {
					type: ["string", "null"],
					description: "Guild ID to query. If null, use the current server when available."
				},
				includeChannels: {
					type: ["boolean", "null"],
					description: "Include the list of channels."
				},
				includeRoles: {
					type: ["boolean", "null"],
					description: "Include the list of roles."
				}
			},
			required: ["guildId", "includeChannels", "includeRoles"],
			additionalProperties: false
		}
	},

	async execute({ guildId, includeChannels, includeRoles }, context: ToolContext) {
		const guild = await resolveGuild(guildId, context);

		if (!guild) {
			return { ok: false, error: "Guild not found or not available in this context." };
		}

		await guild.channels.fetch();

		const info: Record<string, any> = {
			ok: true,
			guild: {
				id: guild.id,
				name: guild.name,
				memberCount: guild.memberCount,
				ownerId: guild.ownerId,
				createdAt: guild.createdAt,
				preferredLocale: guild.preferredLocale,
				verificationLevel: guild.verificationLevel
			}
		};

		if (includeChannels ?? true) {
			const channels = guild.channels.cache
				.sort((a, b) => ((a as any).rawPosition ?? 0) - ((b as any).rawPosition ?? 0))
				.map((channel) => ({
					id: channel.id,
					name: channel.name,
					type: ChannelType[channel.type] || channel.type,
					parentId: channel.parentId || null
				}));

			info.channels = channels;
		}

		if (includeRoles ?? true) {
			const roles = guild.roles.cache
				.sort((a, b) => b.position - a.position)
				.map((role) => ({
					id: role.id,
					name: role.name,
					position: role.position,
					color: role.color,
					isEveryone: role.id === guild.id
				}));

			info.roles = roles;
		}

		return info;
	}
};

export const listEmojisTool: Tool = {
	definition: {
		name: "list_emojis",
		description: "List available custom emojis with id, name, and animated flag.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				query: {
					type: ["string", "null"],
					description: "Optional name filter to match emoji names."
				}
			},
			required: ["query"],
			additionalProperties: false
		}
	},

	async execute({ query }) {
		const needle = query ? query.toLowerCase() : null;
		let entries = Object.entries(ALL_EMOJIS)
			.map(([name, [id, animated]]) => ({ id, name, animated }));

		if (needle)
			entries = entries.filter((item) => item.name.toLowerCase().includes(needle));

		return { ok: true, total: entries.length, items: entries };
	}
};

export const fetchRecentMessagesTool: Tool = {
	definition: {
		name: "fetch_recent_messages",
		description: "Fetch the last N messages from a specified channel.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				channelId: {
					type: ["string", "null"],
					description: "Channel ID to fetch messages from. If null, use the current channel."
				},
				limit: {
					type: "number",
					description: "Number of recent messages to fetch (1-50)."
				}
			},
			required: ["channelId", "limit"],
			additionalProperties: false
		}
	},

	async execute({ channelId, limit }, context: ToolContext) {
		const channel = await resolveChannel(channelId, context);
		if (!channel?.isTextBased()) {
			return { ok: false, error: "Target channel is not text-based or not found." };
		}

		const capped = Math.max(1, Math.min(50, Math.floor(limit || 1)));
		const messages = await channel.messages.fetch({ limit: capped });
		const items = Array.from(messages.values() as Iterable<any>)
			.sort((a, b) => b.createdTimestamp - a.createdTimestamp)
			.map((msg) => ({
				id: msg.id,
				channelId: msg.channel.id,
				author: {
					id: msg.author.id,
					username: msg.author.username,
					displayName: msg.member?.displayName || msg.author.globalName || msg.author.username
				},
				content: msg.content,
				createdAt: msg.createdAt,
				attachments: Array.from(msg.attachments.values() as Iterable<any>).map((att) => ({
					id: att.id,
					name: att.name,
					url: att.url,
					contentType: att.contentType
				}))
			}));

		return { ok: true, count: items.length, items };
	}
};

export const searchMessagesTool: Tool = {
	definition: {
		name: "search_messages",
		description: "Search messages server-wide using Discord's official search endpoint with filters.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				guildId: {
					type: ["string", "null"],
					description: "Guild ID to search. If null, use the current server when available."
				},
				query: {
					type: "string",
					description: "Search keyword to match in message content (content query)."
				},
				limit: {
					type: ["number", "null"],
					description: "Max results to return (1-25)."
				},
				scanLimit: {
					type: ["number", "null"],
					description: "How many channels to include when auto-selecting (1-50)."
				},
				channelLimit: {
					type: ["number", "null"],
					description: "Max number of channels to scan (1-50)."
				},
				sortBy: {
					type: ["string", "null"],
					description: "Sorting mode (e.g., timestamp)."
				},
				sortOrder: {
					type: ["string", "null"],
					description: "Sorting order (asc or desc)."
				},
				authorIds: {
					type: ["array", "null"],
					items: { type: ["string", "null"] },
					description: "Filter by author IDs."
				},
				mentions: {
					type: ["array", "null"],
					items: { type: ["string", "null"] },
					description: "Filter by mentioned user IDs."
				},
				channelIds: {
					type: ["array", "null"],
					items: { type: "string" },
					description: "Restrict search to specific channel IDs."
				},
				minId: {
					type: ["string", "null"],
					description: "Minimum message ID (snowflake)."
				},
				maxId: {
					type: ["string", "null"],
					description: "Maximum message ID (snowflake)."
				},
				offset: {
					type: ["number", "null"],
					description: "Result offset (0-9975)."
				},
				pinned: {
					type: ["boolean", "null"],
					description: "Only pinned messages."
				},
				includeNsfw: {
					type: ["boolean", "null"],
					description: "Include NSFW channels."
				}
			},
			required: ["guildId", "query", "limit", "scanLimit", "channelLimit", "sortBy", "sortOrder", "authorIds", "mentions", "channelIds", "minId", "maxId", "offset", "pinned", "includeNsfw"],
			additionalProperties: false
		}
	},

	async execute({
		guildId,
		query,
		limit,
		scanLimit,
		channelLimit,
		sortBy,
		sortOrder,
		authorIds,
		mentions,
		channelIds,
		minId,
		maxId,
		offset,
		pinned,
		includeNsfw
	}, context: ToolContext) {
		const guild = await resolveGuild(guildId, context);
		if (!guild) {
			return { ok: false, error: "Guild not found or not available in this context." };
		}

		const needle = (query || "").trim();
		if (!needle) {
			return { ok: false, error: "Search query cannot be empty." };
		}

		const maxResults = Math.max(1, Math.min(25, Math.floor(limit || 10)));
		const channelMax = Math.max(1, Math.min(50, Math.floor(channelLimit || 20)));
		const scanCount = Math.max(1, Math.min(50, Math.floor(scanLimit || channelMax)));

		let resolvedChannelIds: string[] = [];
		if (Array.isArray(channelIds) && channelIds.length > 0) {
			resolvedChannelIds = channelIds.filter(Boolean).slice(0, 500);
		} else {
			await guild.channels.fetch();
			const channels = guild.channels.cache
				.filter((ch: any) => ch.isTextBased() && ch.viewable)
				.sort((a: any, b: any) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0))
				.first(channelMax);

			resolvedChannelIds = channels.map((ch: any) => ch.id).slice(0, scanCount);
		}
		const queryParams = new URLSearchParams();
		queryParams.set("content", needle);
		queryParams.set("limit", String(maxResults));
		if (sortBy)
			queryParams.set("sort_by", sortBy);
		else
			queryParams.set("sort_by", "timestamp");
		if (sortOrder)
			queryParams.set("sort_order", sortOrder);
		else
			queryParams.set("sort_order", "desc");
		if (typeof includeNsfw === "boolean")
			queryParams.set("include_nsfw", String(includeNsfw));
		else
			queryParams.set("include_nsfw", "true");
		if (minId)
			queryParams.set("min_id", minId);
		if (maxId)
			queryParams.set("max_id", maxId);
		if (typeof offset === "number")
			queryParams.set("offset", String(Math.max(0, Math.min(9975, Math.floor(offset)))));
		if (typeof pinned === "boolean")
			queryParams.set("pinned", String(pinned));
		if (Array.isArray(authorIds)) {
			for (const id of authorIds.filter(Boolean))
				queryParams.append("author_id", id);
		}
		if (Array.isArray(mentions)) {
			for (const id of mentions.filter(Boolean))
				queryParams.append("mentions", id);
		}
		for (const id of resolvedChannelIds) {
			queryParams.append("channel_id", id);
		}

		let data: any = null;
		try {
			data = await discord.rest.get(`/guilds/${guild.id}/messages/search?${queryParams.toString()}` as any);
		} catch (err: any) {
			log.error(`Message search failed:`, err);

			if (err?.status === 202) {
				return { ok: false, status: 202, error: "Search index not ready. Try again shortly." };
			}
			return { ok: false, error: err?.message || "Failed to search messages via Discord API." };
		}

		const items = (data?.messages || [])
			.flat()
			.slice(0, maxResults)
			.map((msg: any) => ({
				id: msg.id,
				channelId: msg.channel_id,
				author: {
					id: msg.author?.id,
					username: msg.author?.username,
					displayName: msg.author?.global_name || msg.author?.username
				},
				content: msg.content,
				createdAt: msg.timestamp
			}));

		return { ok: true, count: items.length, total: data?.total_results ?? items.length, items };
	}
};
