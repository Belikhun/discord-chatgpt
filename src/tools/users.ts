import { scope } from "../logger";
import { getUser } from "../discord/client";
import { ALL_EMOJIS } from "../emojis";
import { resolveChannel, resolveGuild } from "./resolve";
import type { Tool, ToolContext } from "./types";

const log = scope("chat-tool");

export const getUserInfoTool: Tool = {
	definition: {
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

	async execute({ userId, guildId, includePresence }, context: ToolContext) {
		const user = await getUser(userId);
		const guild = await resolveGuild(guildId, context);
		let member = null;

		if (guild) {
			try {
				member = await guild.members.fetch(userId);
			} catch (err) {
				member = null;
			}
		}

		const result: Record<string, any> = {
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
};

export const reactMessageTool: Tool = {
	definition: {
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

	async execute({ channelId, messageId, emoji }, context: ToolContext) {
		const channel = await resolveChannel(channelId, context);

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
				const key = nameMatch[1] as string;
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
		log.debug(`Reacting to message ${message.id} in channel ${channel.id} with emoji ${emojiInput}`);
		await message.react(emojiInput);

		return {
			ok: true,
			messageId: message.id,
			emoji: emojiInput
		};
	}
};

export const forwardMessageTool: Tool = {
	definition: {
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

	async execute({ fromChannelId, messageId, toChannelId }, context: ToolContext) {
		const fromChannel = await resolveChannel(fromChannelId, context);
		const toChannel = await resolveChannel(toChannelId, context);

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
};
