import { ChannelType } from "discord.js";
import { getChannel, getGuild, getUser } from "../clients/discord.js";
import { scope } from "../logger.js";
import fs from "node:fs";
import path from "node:path";
import { ALL_EMOJIS } from "../utils.js";

export class ChatTool {
	static log = scope("chat-tool");
	static memoryFilePath = path.join(process.cwd(), "data", "memories.json");
	static memoryTtlMs = 86400000;

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
				description: "Create a short-term memory item in the server's memory bank (expires in 1 day).",
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
						}
					},
					required: ["guildId", "content"],
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

				case "list_emojis":
					return this.wrapToolOutput(call_id, await this.listEmojis(args));

				default:
					return this.wrapToolOutput(call_id, {
						ok: false,
						error: `Unknown tool: ${name}`
					});
			}
		} catch (err) {
			this.log.error(`Tool ${name} failed: ${err?.message || err}`);
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
		const authorName = message.member?.displayName || message.author.globalName || message.author.username;
		const header = `Forwarded from ${authorName} (<@${message.author.id}>) in ${fromChannel.name ? `#${fromChannel.name}` : "DM"}`;

		const files = (includeAttachments ?? true)
			? Array.from(message.attachments.values()).map((attachment) => attachment.url)
			: [];

		const embeds = (includeEmbeds ?? true) ? message.embeds : [];

		const payload = {
			content: [header, message.content].filter(Boolean).join("\n"),
			allowedMentions: { parse: [] }
		};

		if (files.length > 0)
			payload.files = files;

		if (embeds.length > 0)
			payload.embeds = embeds;

		const sent = await toChannel.send(payload);

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

	static ensureMemoryStore() {
		if (!fs.existsSync(this.memoryFilePath)) {
			fs.mkdirSync(path.dirname(this.memoryFilePath), { recursive: true });
			fs.writeFileSync(this.memoryFilePath, "{}", "utf8");
		}
	}

	static loadMemoryStore() {
		this.ensureMemoryStore();
		try {
			const raw = fs.readFileSync(this.memoryFilePath, "utf8");
			return JSON.parse(raw || "{}");
		} catch (err) {
			this.log.error(`Failed to read memories.json: ${err.message}`);
			return {};
		}
	}

	static saveMemoryStore(store) {
		this.ensureMemoryStore();
		fs.writeFileSync(this.memoryFilePath, JSON.stringify(store, null, 2), "utf8");
	}

	static purgeExpiredMemories(store) {
		let changed = false;
		const now = Date.now();

		for (const guildId of Object.keys(store)) {
			const items = Array.isArray(store[guildId]) ? store[guildId] : [];
			const fresh = items.filter((item) => (item?.expiresAt ?? 0) > now);
			if (fresh.length !== items.length) {
				store[guildId] = fresh;
				changed = true;
			}
		}

		return changed;
	}

	static async listMemories({ guildId, query, limit }, context) {
		const guild = await this.resolveGuild(guildId, context);
		if (!guild) {
			return { ok: false, error: "Guild not found or not available in this context." };
		}

		const store = this.loadMemoryStore();
		const changed = this.purgeExpiredMemories(store);
		if (changed)
			this.saveMemoryStore(store);

		let items = Array.isArray(store[guild.id]) ? store[guild.id] : [];
		if (query) {
			const needle = query.toLowerCase();
			items = items.filter((item) => (item?.content || "").toLowerCase().includes(needle));
		}

		items = items.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
		const max = Math.max(1, Math.min(100, limit ?? 20));
		const sliced = items.slice(0, max);

		return {
			ok: true,
			total: items.length,
			items: sliced
		};
	}

	static async createMemory({ guildId, content }, context) {
		const guild = await this.resolveGuild(guildId, context);
		if (!guild) {
			return { ok: false, error: "Guild not found or not available in this context." };
		}

		const trimmed = (content || "").trim();
		if (!trimmed) {
			return { ok: false, error: "Memory content cannot be empty." };
		}

		const store = this.loadMemoryStore();
		this.purgeExpiredMemories(store);
		if (!store[guild.id])
			store[guild.id] = [];

		const now = Date.now();
		const item = {
			id: `${guild.id}-${now}-${Math.random().toString(36).slice(2, 8)}`,
			content: trimmed,
			createdAt: now,
			expiresAt: now + this.memoryTtlMs,
			authorId: context?.message?.author?.id || null,
			channelId: context?.message?.channel?.id || null,
			messageId: context?.message?.id || null
		};

		store[guild.id].push(item);
		this.saveMemoryStore(store);

		return { ok: true, item };
	}

	static async listEmojis({ query } = {}) {
		const needle = query ? query.toLowerCase() : null;
		let entries = Object.entries(ALL_EMOJIS)
			.map(([name, [id, animated]]) => ({ id, name, animated }));

		if (needle)
			entries = entries.filter((item) => item.name.toLowerCase().includes(needle));

		return { ok: true, total: entries.length, items: entries };
	}
}
