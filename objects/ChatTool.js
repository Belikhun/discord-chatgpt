import { ChannelType } from "discord.js";
import { discord } from "../clients/discord.js";
import { getChannel, getGuild, getUser } from "../clients/discord.js";
import { scope } from "../logger.js";
import { ALL_EMOJIS } from "../utils.js";
import { listConversations as listStoredConversations } from "../store/conversation.js";
import { listMemoriesForGuild, createMemoryForGuild } from "../store/memory.js";

export class ChatTool {
	static log = scope("chat-tool");

	static tools() {
		return [
			{
				type: "function",
				name: "get_user_info",
				description: "Get detailed information about a Discord user, including basic profile info and roles in a specific server.",
				strict: true,
				parameters: {
					type: "object",
					properties: {
						userId: {
							type: "string",
							description: "Discord user ID."
						},
						guildId: {
							type: ["string", "null"],
							description: "Discord guild (server) ID to resolve roles. If null, use the current server when available."
						},
						includePresence: {
							type: ["boolean", "null"],
							description: "Include presence info if available."
						}
					},
					required: ["userId", "guildId", "includePresence"],
					additionalProperties: false
				}
			},
			{
				type: "function",
				name: "react_message",
				description: "React to a Discord message. Provide emoji as: (1) Unicode emoji like 😄, OR (2) custom emoji ID like 123456789012345678, OR (3) emoji mention formats like <:name:id>, <a:name:id>, name:id, a:name:id (the tool will extract the ID).",
				strict: true,
				parameters: {
					type: "object",
					properties: {
						channelId: {
							type: ["string", "null"],
							description: "Channel ID containing the target message. If null, use the current channel."
						},
						messageId: {
							type: "string",
							description: "Message ID to react to."
						},
						emoji: {
							type: "string",
							description: "Emoji to react with. Use Unicode (😄), ID (123456789012345678), or formats <:name:id>, <a:name:id>, name:id, a:name:id."
						}
					},
					required: ["channelId", "messageId", "emoji"],
					additionalProperties: false
				}
			},
			{
				type: "function",
				name: "forward_message",
				description: "Forward a message from one channel to another, optionally including attachments and embeds.",
				strict: true,
				parameters: {
					type: "object",
					properties: {
						fromChannelId: {
							type: ["string", "null"],
							description: "Source channel ID. If null, use the current channel."
						},
						messageId: {
							type: "string",
							description: "Message ID to forward."
						},
						toChannelId: {
							type: "string",
							description: "Destination channel ID."
						},
						includeAttachments: {
							type: ["boolean", "null"],
							description: "Include attachments if available."
						},
						includeEmbeds: {
							type: ["boolean", "null"],
							description: "Include embeds if available."
						}
					},
					required: ["fromChannelId", "messageId", "toChannelId", "includeAttachments", "includeEmbeds"],
					additionalProperties: false
				}
			},
			{
				type: "function",
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
			{
				type: "function",
				name: "list_memories",
				description: "List or search short-term memory items for a Discord server.",
				strict: true,
				parameters: {
					type: "object",
					properties: {
						guildId: {
							type: ["string", "null"],
							description: "Guild ID to query. If null, use the current server when available."
						},
						query: {
							type: ["string", "null"],
							description: "Search query to filter memory items by content."
						},
						limit: {
							type: ["number", "null"],
							description: "Maximum number of items to return."
						}
					},
					required: ["guildId", "query", "limit"],
					additionalProperties: false
				}
			},
			{
				type: "function",
				name: "create_memory",
				description: "Create a short-term memory item in the server's memory bank with an optional custom expiration duration (in seconds).",
				strict: true,
				parameters: {
					type: "object",
					properties: {
						guildId: {
							type: ["string", "null"],
							description: "Guild ID to store memory. If null, use the current server when available."
						},
						content: {
							type: "string",
							description: "Memory content to store."
						},
						ttlSeconds: {
							type: ["number", "null"],
							description: "Expiration duration in seconds. If null, use the default duration."
						}
					},
					required: ["guildId", "content", "ttlSeconds"],
					additionalProperties: false
				}
			},
			{
				type: "function",
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
			{
				type: "function",
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
			{
				type: "function",
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
			{
				type: "function",
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
			{
				type: "function",
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
			}
		];
	}

	static extractToolCalls(output = []) {
		return output.filter((item) => item?.type === "function_call");
	}

	static async runToolCalls(toolCalls, context = {}) {
		const results = [];

		for (const call of toolCalls) {
			results.push(await this.runToolCall(call, context));
		}

		return results;
	}

	static async runToolCall(call, context = {}) {
		const { name, call_id } = call;
		let args = {};

		try {
			args = (call?.arguments) ? JSON.parse(call.arguments) : {};
		} catch (err) {
			return this.wrapToolOutput(call_id, {
				ok: false,
				error: `Invalid tool arguments JSON: ${err.message}`
			});
		}

		try {
			switch (name) {
				case "get_user_info":
					return this.wrapToolOutput(call_id, await this.getUserInfo(args, context));

				case "react_message":
					return this.wrapToolOutput(call_id, await this.reactMessage(args, context));

				case "forward_message":
					return this.wrapToolOutput(call_id, await this.forwardMessage(args, context));

				case "get_server_info":
					return this.wrapToolOutput(call_id, await this.getServerInfo(args, context));

				case "list_memories":
					return this.wrapToolOutput(call_id, await this.listMemories(args, context));

				case "create_memory":
					return this.wrapToolOutput(call_id, await this.createMemory(args, context));

				case "list_conversations":
					return this.wrapToolOutput(call_id, await this.listConversations(args, context));

				case "search_conversation_history":
					return this.wrapToolOutput(call_id, await this.searchConversationHistory(args, context));

				case "list_emojis":
					return this.wrapToolOutput(call_id, await this.listEmojis(args));

				case "fetch_recent_messages":
					return this.wrapToolOutput(call_id, await this.fetchRecentMessages(args, context));

				case "search_messages":
					return this.wrapToolOutput(call_id, await this.searchMessages(args, context));

				default:
					return this.wrapToolOutput(call_id, {
						ok: false,
						error: `Unknown tool: ${name}`
					});
			}
		} catch (err) {
			const detail = {
				name,
				arguments: args,
				error: err?.message || String(err),
				stack: err?.stack || null
			};
			this.log.error(`Tool ${name} failed: ${detail.error}`);
			this.log.error(detail);
			return this.wrapToolOutput(call_id, {
				ok: false,
				error: err?.message || String(err)
			});
		}
	}

	static wrapToolOutput(callId, payload) {
		return {
			type: "function_call_output",
			call_id: callId,
			output: JSON.stringify(payload)
		};
	}

	static async resolveChannel(channelId, context) {
		if (channelId)
			return await getChannel(channelId);

		return context?.conversation?.channel || null;
	}

	static async resolveGuild(guildId, context) {
		if (guildId)
			return await getGuild(guildId);

		return context?.conversation?.channel?.guild || null;
	}

	static async getUserInfo({ userId, guildId, includePresence }, context) {
		const user = await getUser(userId);
		const guild = await this.resolveGuild(guildId, context);
		let member = null;

		if (guild) {
			try {
				member = await guild.members.fetch(userId);
			} catch (err) {
				member = null;
			}
		}

		const result = {
			ok: true,
			user: {
				id: user.id,
				username: user.username,
				globalName: user.globalName || null,
				displayName: user.globalName || user.username,
				bot: user.bot,
				createdAt: user.createdAt,
				avatarUrl: user.displayAvatarURL()
			},
			guildMember: null
		};

		if (member) {
			const roles = member.roles.cache
				.sort((a, b) => b.position - a.position)
				.map((role) => ({
					id: role.id,
					name: role.name,
					position: role.position,
					isEveryone: role.id === member.guild.id
				}));

			result.guildMember = {
				guildId: member.guild.id,
				nickname: member.nickname || null,
				displayName: member.displayName,
				joinedAt: member.joinedAt,
				roles,
				permissions: member.permissions.toArray()
			};
		}

		if (includePresence && member?.presence) {
			result.presence = {
				status: member.presence.status,
				activities: member.presence.activities?.map((activity) => ({
					name: activity.name,
					type: activity.type,
					state: activity.state || null
				})) || []
			};
		}

		return result;
	}

	static async reactMessage({ channelId, messageId, emoji }, context) {
		const channel = await this.resolveChannel(channelId, context);

		if (!channel?.isTextBased()) {
			return { ok: false, error: "Target channel is not text-based or not found." };
		}

		let emojiInput = emoji;
		if (typeof emojiInput === "string") {
			const trimmed = emojiInput.trim();
			const customMatch = trimmed.match(/^<a?:\w+:(\d+)>$/);
			const nameMatch = trimmed.match(/^:([a-zA-Z0-9_]+):$/);
			const namedIdMatch = trimmed.match(/^([a-zA-Z0-9_]+)\s*:\s*(\d+)$/);
			const animatedNamedIdMatch = trimmed.match(/^a:([a-zA-Z0-9_]+)\s*:\s*(\d+)$/);
			if (customMatch) {
				emojiInput = customMatch[1];
			} else if (animatedNamedIdMatch) {
				emojiInput = animatedNamedIdMatch[2];
			} else if (namedIdMatch) {
				emojiInput = namedIdMatch[2];
			} else if (nameMatch) {
				const key = nameMatch[1];
				const mapped = ALL_EMOJIS[key];
				if (mapped)
					emojiInput = mapped[0];
			} else if (/^[a-zA-Z0-9_]+$/.test(trimmed)) {
				const mapped = ALL_EMOJIS[trimmed];
				if (mapped)
					emojiInput = mapped[0];
			}
		}

		const message = await channel.messages.fetch(messageId);
		this.log.debug(`Reacting to message ${message.id} in channel ${channel.id} with emoji ${emojiInput}`);
		await message.react(emojiInput);

		return {
			ok: true,
			messageId: message.id,
			emoji: emojiInput
		};
	}

	static async forwardMessage({ fromChannelId, messageId, toChannelId, includeAttachments, includeEmbeds }, context) {
		const fromChannel = await this.resolveChannel(fromChannelId, context);
		const toChannel = await this.resolveChannel(toChannelId, context);

		if (!fromChannel?.isTextBased()) {
			return { ok: false, error: "Source channel is not text-based or not found." };
		}

		if (!toChannel?.isTextBased()) {
			return { ok: false, error: "Destination channel is not text-based or not found." };
		}

		const message = await fromChannel.messages.fetch(messageId);
		const sent = await message.forward(toChannel);

		return {
			ok: true,
			forwardedMessageId: sent.id,
			fromChannelId: fromChannel.id,
			toChannelId: toChannel.id
		};
	}

	static async getServerInfo({ guildId, includeChannels, includeRoles }, context) {
		const guild = await this.resolveGuild(guildId, context);

		if (!guild) {
			return { ok: false, error: "Guild not found or not available in this context." };
		}

		await guild.channels.fetch();

		const info = {
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
				.sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0))
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

	static async listMemories({ guildId, query, limit }, context) {
		const guild = await this.resolveGuild(guildId, context);
		if (!guild) {
			return { ok: false, error: "Guild not found or not available in this context." };
		}

		return listMemoriesForGuild(guild, { query, limit });
	}

	static async createMemory({ guildId, content, ttlSeconds }, context) {
		const guild = await this.resolveGuild(guildId, context);
		if (!guild) {
			return { ok: false, error: "Guild not found or not available in this context." };
		}

		return createMemoryForGuild(guild, { content, ttlSeconds, context });
	}

	static extractConversationTexts(item) {
		const texts = [];
		if (!item)
			return texts;

		const content = item.content;
		if (Array.isArray(content)) {
			for (const part of content) {
				if (part?.type === "input_text" && typeof part.text === "string")
					texts.push(part.text);
				if (part?.type === "output_text" && typeof part.text === "string")
					texts.push(part.text);
			}
		} else if (typeof content === "string") {
			texts.push(content);
		}

		return texts;
	}

	static async listConversations({ guildId, includeCurrent, limit }, context) {
		const guild = await this.resolveGuild(guildId, context);
		if (guildId && !guild) {
			return { ok: false, error: "Guild not found or not available in this context." };
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
				const history = Array.isArray(conversation.history) ? conversation.history : [];
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

	static async searchConversationHistory({
		guildId,
		channelIds,
		query,
		limit,
		maxPerChannel,
		includeCurrent
	}, context) {
		const guild = await this.resolveGuild(guildId, context);
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

		const results = [];
		for (const conversation of listStoredConversations()) {
			if (!conversation?.channel)
				continue;
			if (!includeSelf && conversation.channel.id === currentChannelId)
				continue;
			if (guild?.id && conversation.channel.guild?.id !== guild.id)
				continue;
			if (allowedIds && !allowedIds.has(conversation.channel.id))
				continue;

			const history = Array.isArray(conversation.history) ? conversation.history : [];
			let perChannelCount = 0;
			for (const item of history) {
				if (perChannelCount >= maxEach || results.length >= maxTotal)
					break;

				const texts = this.extractConversationTexts(item);
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
						role: item?.role || null,
						timestamp: item?.timestamp ?? null,
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

	static async listEmojis({ query } = {}) {
		const needle = query ? query.toLowerCase() : null;
		let entries = Object.entries(ALL_EMOJIS)
			.map(([name, [id, animated]]) => ({ id, name, animated }));

		if (needle)
			entries = entries.filter((item) => item.name.toLowerCase().includes(needle));

		return { ok: true, total: entries.length, items: entries };
	}

	static async fetchRecentMessages({ channelId, limit }, context) {
		const channel = await this.resolveChannel(channelId, context);
		if (!channel?.isTextBased()) {
			return { ok: false, error: "Target channel is not text-based or not found." };
		}

		const capped = Math.max(1, Math.min(50, Math.floor(limit || 1)));
		const messages = await channel.messages.fetch({ limit: capped });
		const items = Array.from(messages.values())
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
				attachments: Array.from(msg.attachments.values()).map((att) => ({
					id: att.id,
					name: att.name,
					url: att.url,
					contentType: att.contentType
				}))
			}));

		return { ok: true, count: items.length, items };
	}

	static async searchMessages({
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
	}, context) {
		const guild = await this.resolveGuild(guildId, context);
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

		let resolvedChannelIds = [];
		if (Array.isArray(channelIds) && channelIds.length > 0) {
			resolvedChannelIds = channelIds.filter(Boolean).slice(0, 500);
		} else {
			await guild.channels.fetch();
			const channels = guild.channels.cache
				.filter((ch) => ch.isTextBased() && ch.viewable)
				.sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0))
				.first(channelMax);

			resolvedChannelIds = channels.map((ch) => ch.id).slice(0, scanCount);
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

		let data = null;
		try {
			data = await discord.rest.get(`/guilds/${guild.id}/messages/search?${queryParams.toString()}`);
		} catch (err) {
			this.log.error(`Message search failed:`, err);

			if (err?.status === 202) {
				return { ok: false, status: 202, error: "Search index not ready. Try again shortly." };
			}
			return { ok: false, error: err?.message || "Failed to search messages via Discord API." };
		}

		const items = (data?.messages || [])
			.flat()
			.slice(0, maxResults)
			.map((msg) => ({
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
}
