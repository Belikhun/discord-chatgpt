import { discord } from "../../discord/client";
import {
	clearUserWarnings,
	getModerationHistory,
	getModerationProfile,
	listGuildModerationProfiles,
	recordModerationAction,
	WARNING_THRESHOLD_FOR_KICK
} from "../../stores/moderation";
import { resolveChannel, resolveGuild } from "../resolve";
import type { Tool, ToolContext } from "../types";
import { requireFullModerationAccess } from "./capabilities";
import {
	enrichModerationUsers,
	normalizeEvidenceMessageIds,
	resolveGuildMember,
	summarizeModerationProfile,
	trimReason
} from "./helpers";
import { sendModerationDirectMessage, sendWarningClearNotice, sendWarningNotice } from "./notices";

export { buildDeveloperMessages, buildModerationDeveloperPrompt } from "./prompt";
export { getModerationCapabilities, requireFullModerationAccess } from "./capabilities";

const issueWarningTool: Tool = {
	definition: {
		name: "issue_warning",
		description: "Record a public moderation warning for a guild member before stronger action. Warnings expire after 24 hours and should be used before kicking when abusive language, swearing, or attacks continue in chat.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				guildId: {
					type: ["string", "null"],
					description: "Guild ID to moderate in. If null, use the current guild."
				},
				userId: {
					type: "string",
					description: "Discord user ID to warn."
				},
				reason: {
					type: "string",
					description: "Short, specific moderation reason that can be shown publicly."
				},
				evidenceMessageIds: {
					type: ["array", "null"],
					items: { type: "string" },
					description: "Optional related message IDs used as evidence."
				}
			},
			required: ["guildId", "userId", "reason", "evidenceMessageIds"],
			additionalProperties: false
		}
	},

	async execute({ guildId, userId, reason, evidenceMessageIds }, context: ToolContext) {
		const access = await requireFullModerationAccess(context);
		if (!access.ok)
			return access;

		const guild = await resolveGuild(guildId, context);
		if (!guild)
			return { ok: false, error: "Không tìm thấy máy chủ hoặc máy chủ không khả dụng trong ngữ cảnh hiện tại." };

		const member = await resolveGuildMember(guild, userId);
		if (!member)
			return { ok: false, error: "Không tìm thấy thành viên mục tiêu trong máy chủ." };

		const cleanReason = trimReason(reason);
		if (!cleanReason)
			return { ok: false, error: "Cần cung cấp lý do cảnh cáo." };

		const recorded = recordModerationAction(guild.id, member.id, {
			action: "warning",
			reason: cleanReason,
			actorId: discord.user?.id || null,
			channelId: context?.message?.channel?.id || context?.conversation?.channel?.id || null,
			messageId: context?.message?.id || null,
			messageIds: normalizeEvidenceMessageIds(evidenceMessageIds)
		});
		const publicNotice = await sendWarningNotice({
			channel: context?.message?.channel || context?.conversation?.channel || null,
			member,
			reason: cleanReason,
			warningExpiresAt: recorded.action.metadata?.expiresAt || null,
			profile: recorded.profile
		});

		return {
			ok: true,
			action: "warning",
			guildId: guild.id,
			userId: member.id,
			displayName: member.displayName,
			reason: cleanReason,
			warningExpiresAt: recorded.action.metadata?.expiresAt || null,
			publicNotice,
			profile: summarizeModerationProfile(recorded.profile)
		};
	}
};

const clearUserWarningsTool: Tool = {
	definition: {
		name: "clear_user_warnings",
		description: "Clear all active warning status for a guild member when they have rejoined and sincerely apologized. This is a forgiveness action, not a general reset.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				guildId: {
					type: ["string", "null"],
					description: "Guild ID to moderate in. If null, use the current guild."
				},
				userId: {
					type: "string",
					description: "Discord user ID whose active warnings should be cleared."
				},
				reason: {
					type: "string",
					description: "Short explanation that the member rejoined and apologized, or another specific forgiveness reason."
				},
				evidenceMessageIds: {
					type: ["array", "null"],
					items: { type: "string" },
					description: "Optional message IDs that show the apology or context for clearing warnings."
				}
			},
			required: ["guildId", "userId", "reason", "evidenceMessageIds"],
			additionalProperties: false
		}
	},

	async execute({ guildId, userId, reason, evidenceMessageIds }, context: ToolContext) {
		const access = await requireFullModerationAccess(context);
		if (!access.ok)
			return access;

		const guild = await resolveGuild(guildId, context);
		if (!guild)
			return { ok: false, error: "Không tìm thấy máy chủ hoặc máy chủ không khả dụng trong ngữ cảnh hiện tại." };

		const member = await resolveGuildMember(guild, userId);
		if (!member)
			return { ok: false, error: "Không tìm thấy thành viên mục tiêu trong máy chủ." };

		const cleanReason = trimReason(reason);
		if (!cleanReason)
			return { ok: false, error: "Cần cung cấp lý do xóa cảnh cáo." };

		const recorded = clearUserWarnings(guild.id, member.id, {
			reason: cleanReason,
			actorId: discord.user?.id || null,
			channelId: context?.message?.channel?.id || context?.conversation?.channel?.id || null,
			messageId: context?.message?.id || null,
			messageIds: normalizeEvidenceMessageIds(evidenceMessageIds)
		});
		const clearedWarningCount = recorded.action.metadata?.clearedWarningCount || 0;
		const publicNotice = await sendWarningClearNotice({
			channel: context?.message?.channel || context?.conversation?.channel || null,
			member,
			reason: cleanReason,
			clearedWarningCount,
			profile: recorded.profile
		});

		return {
			ok: true,
			action: "clear_warnings",
			guildId: guild.id,
			userId: member.id,
			displayName: member.displayName,
			reason: cleanReason,
			clearedWarningCount,
			publicNotice,
			profile: summarizeModerationProfile(recorded.profile)
		};
	}
};

const deleteMessagesTool: Tool = {
	definition: {
		name: "delete_messages",
		description: "Delete one or more messages in the current guild channel. Supports exact message IDs or cleanup mode using a recent message count with an optional author filter.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				channelId: {
					type: ["string", "null"],
					description: "Channel ID to delete messages from. If null, use the current channel."
				},
				messageIds: {
					type: ["array", "null"],
					items: { type: "string" },
					description: "Exact message IDs to delete. Leave null when using cleanup mode."
				},
				recentCount: {
					type: ["number", "null"],
					description: "Number of recent messages to delete in cleanup mode (1-100). Leave null when using exact message IDs."
				},
				authorId: {
					type: ["string", "null"],
					description: "Optional author ID filter for cleanup mode."
				},
				reason: {
					type: ["string", "null"],
					description: "Optional moderation reason for the cleanup."
				}
			},
			required: ["channelId", "messageIds", "recentCount", "authorId", "reason"],
			additionalProperties: false
		}
	},

	async execute({ channelId, messageIds, recentCount, authorId, reason }, context: ToolContext) {
		const access = await requireFullModerationAccess(context);
		if (!access.ok)
			return access;

		const channel = await resolveChannel(channelId, context);
		if (!channel?.isTextBased())
			return { ok: false, error: "Không tìm thấy kênh mục tiêu hoặc kênh đó không phải kênh văn bản." };

		const ids: string[] = Array.isArray(messageIds) ? [...new Set(messageIds.filter(Boolean))] as string[] : [];
		const hasCleanupMode = Number.isFinite(recentCount) && recentCount > 0;
		if (ids.length === 0 && !hasCleanupMode)
			return { ok: false, error: "Hãy cung cấp danh sách messageIds cụ thể hoặc recentCount để dọn kênh." };

		if (ids.length > 0 && hasCleanupMode)
			return { ok: false, error: "Chỉ được dùng một trong hai chế độ: messageIds cụ thể hoặc recentCount để dọn kênh." };

		let targets: any[] = [];
		const missingMessageIds: string[] = [];
		let scannedCount = 0;

		if (ids.length > 0) {
			const fetches = await Promise.allSettled(ids.slice(0, 100).map((id) => channel.messages.fetch(id)));
			for (let index = 0; index < fetches.length; index += 1) {
				const result = fetches[index] as PromiseSettledResult<any>;
				if (result.status === "fulfilled") {
					targets.push(result.value);
					continue;
				}

				missingMessageIds.push(ids[index] as string);
			}
		} else {
			const requestedCount = Math.max(1, Math.min(100, Math.floor(recentCount)));
			const scanBudget = Math.max(requestedCount, Math.min(500, requestedCount * (authorId ? 10 : 3)));
			let before: string | null = null;

			while (scannedCount < scanBudget && targets.length < requestedCount) {
				const batch: any = await channel.messages.fetch({
					limit: Math.min(100, scanBudget - scannedCount),
					...(before ? { before } : {})
				});

				if (batch.size === 0)
					break;

				for (const message of batch.values()) {
					scannedCount += 1;
					if (authorId && message.author.id !== authorId)
						continue;

					targets.push(message);
					if (targets.length >= requestedCount)
						break;
					if (scannedCount >= scanBudget)
						break;
				}

				before = batch.last()?.id;
				if (!before)
					break;
			}
		}

		const cutoff = Date.now() - (14 * 24 * 60 * 60 * 1000);
		const recentMessages = targets.filter((message) => message.createdTimestamp >= cutoff);
		const oldMessages = targets.filter((message) => message.createdTimestamp < cutoff);
		const deletedMessageIds: string[] = [];
		const failedMessageIds: string[] = [];

		if (recentMessages.length === 1) {
			try {
				await recentMessages[0].delete();
				deletedMessageIds.push(recentMessages[0].id);
			} catch (err) {
				failedMessageIds.push(recentMessages[0].id);
			}
		} else if (recentMessages.length > 1) {
			try {
				const deleted = await channel.bulkDelete(recentMessages, true);
				deletedMessageIds.push(...deleted.keys());
			} catch (err) {
				for (const message of recentMessages) {
					try {
						await message.delete();
						deletedMessageIds.push(message.id);
					} catch (deleteErr) {
						failedMessageIds.push(message.id);
					}
				}
			}
		}

		for (const message of oldMessages) {
			try {
				await message.delete();
				deletedMessageIds.push(message.id);
			} catch (err) {
				failedMessageIds.push(message.id);
			}
		}

		const logged = recordModerationAction(channel.guild?.id || (context?.conversation?.channel as any)?.guild?.id, authorId || null, {
			action: "delete_messages",
			reason: trimReason(reason),
			actorId: discord.user?.id || null,
			channelId: channel.id,
			messageId: context?.message?.id || null,
			messageIds: deletedMessageIds,
			metadata: {
				mode: ids.length > 0 ? "exact_ids" : "cleanup",
				authorId: authorId || null,
				scannedCount: ids.length > 0 ? ids.length : scannedCount,
				matchedCount: targets.length,
				deletedCount: deletedMessageIds.length,
				missingMessageIds,
				failedMessageIds
			}
		});

		return {
			ok: true,
			action: "delete_messages",
			channelId: channel.id,
			reason: trimReason(reason),
			mode: ids.length > 0 ? "exact_ids" : "cleanup",
			authorId: authorId || null,
			scannedCount: ids.length > 0 ? ids.length : scannedCount,
			matchedCount: targets.length,
			deletedCount: deletedMessageIds.length,
			historyId: logged.action.id,
			deletedMessageIds,
			missingMessageIds,
			failedMessageIds
		};
	}
};

const kickUserTool: Tool = {
	definition: {
		name: "kick_user",
		description: "Kick a guild member for continued abusive behavior only after they have 3 active warnings within the last 24 hours. This tool attempts to DM the member before kicking.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				guildId: {
					type: ["string", "null"],
					description: "Guild ID to moderate in. If null, use the current guild."
				},
				userId: {
					type: "string",
					description: "Discord user ID to kick."
				},
				reason: {
					type: "string",
					description: "Clear moderation reason for the kick."
				},
				evidenceMessageIds: {
					type: ["array", "null"],
					items: { type: "string" },
					description: "Optional related message IDs used as evidence."
				}
			},
			required: ["guildId", "userId", "reason", "evidenceMessageIds"],
			additionalProperties: false
		}
	},

	async execute({ guildId, userId, reason, evidenceMessageIds }, context: ToolContext) {
		const access = await requireFullModerationAccess(context);
		if (!access.ok)
			return access;

		const guild = await resolveGuild(guildId, context);
		if (!guild)
			return { ok: false, error: "Không tìm thấy máy chủ hoặc máy chủ không khả dụng trong ngữ cảnh hiện tại." };

		const member = await resolveGuildMember(guild, userId);
		if (!member)
			return { ok: false, error: "Không tìm thấy thành viên mục tiêu trong máy chủ." };

		const cleanReason = trimReason(reason);
		if (!cleanReason)
			return { ok: false, error: "Cần cung cấp lý do kick." };

		const profile = getModerationProfile(guild.id, member.id);
		if ((profile.warningCount || 0) < WARNING_THRESHOLD_FOR_KICK) {
			return {
				ok: false,
				error: `Chỉ được kick sau khi người dùng có ít nhất ${WARNING_THRESHOLD_FOR_KICK} cảnh cáo còn hiệu lực trong 24 giờ gần nhất.`,
				profile: summarizeModerationProfile(profile)
			};
		}

		if (!member.kickable)
			return { ok: false, error: "Bot không thể kick thành viên này do thứ bậc role hoặc thiếu quyền." };

		const dmNotification = await sendModerationDirectMessage({
			member,
			userId: member.id,
			guild,
			action: "kick",
			reason: cleanReason
		});

		await member.kick(cleanReason);
		const recorded = recordModerationAction(guild.id, member.id, {
			action: "kick",
			reason: cleanReason,
			actorId: discord.user?.id || null,
			channelId: context?.message?.channel?.id || context?.conversation?.channel?.id || null,
			messageId: context?.message?.id || null,
			messageIds: normalizeEvidenceMessageIds(evidenceMessageIds),
			metadata: {
				dmNotification
			}
		});

		return {
			ok: true,
			action: "kick",
			guildId: guild.id,
			userId: member.id,
			displayName: member.displayName,
			reason: cleanReason,
			dmNotification,
			profile: summarizeModerationProfile(recorded.profile)
		};
	}
};

const banUserTool: Tool = {
	definition: {
		name: "ban_user",
		description: "Permanently ban a guild member who returned and continued abusive behavior after a prior kick. This tool attempts to DM the member before banning.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				guildId: {
					type: ["string", "null"],
					description: "Guild ID to moderate in. If null, use the current guild."
				},
				userId: {
					type: "string",
					description: "Discord user ID to ban."
				},
				reason: {
					type: "string",
					description: "Clear moderation reason for the permanent ban."
				},
				evidenceMessageIds: {
					type: ["array", "null"],
					items: { type: "string" },
					description: "Optional related message IDs used as evidence."
				}
			},
			required: ["guildId", "userId", "reason", "evidenceMessageIds"],
			additionalProperties: false
		}
	},

	async execute({ guildId, userId, reason, evidenceMessageIds }, context: ToolContext) {
		const access = await requireFullModerationAccess(context);
		if (!access.ok)
			return access;

		const guild = await resolveGuild(guildId, context);
		if (!guild)
			return { ok: false, error: "Không tìm thấy máy chủ hoặc máy chủ không khả dụng trong ngữ cảnh hiện tại." };

		const cleanReason = trimReason(reason);
		if (!cleanReason)
			return { ok: false, error: "Cần cung cấp lý do ban." };

		const member = await resolveGuildMember(guild, userId);
		if (member && !member.bannable)
			return { ok: false, error: "Bot không thể ban thành viên này do thứ bậc role hoặc thiếu quyền." };

		const dmNotification = await sendModerationDirectMessage({
			member,
			userId,
			guild,
			action: "ban",
			reason: cleanReason
		});

		await guild.members.ban(userId, {
			deleteMessageSeconds: 0,
			reason: cleanReason
		});

		const recorded = recordModerationAction(guild.id, userId, {
			action: "ban",
			reason: cleanReason,
			actorId: discord.user?.id || null,
			channelId: context?.message?.channel?.id || context?.conversation?.channel?.id || null,
			messageId: context?.message?.id || null,
			messageIds: normalizeEvidenceMessageIds(evidenceMessageIds),
			metadata: {
				dmNotification
			}
		});

		return {
			ok: true,
			action: "ban",
			guildId: guild.id,
			userId,
			displayName: member?.displayName || null,
			reason: cleanReason,
			dmNotification,
			profile: summarizeModerationProfile(recorded.profile)
		};
	}
};

const queryGuildModerationTool: Tool = {
	definition: {
		name: "query_guild_moderation",
		description: "Query guild-wide moderation records for warnings, kicks, and bans.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				guildId: {
					type: ["string", "null"],
					description: "Guild ID to query. If null, use the current guild."
				},
				actionFilter: {
					type: ["array", "null"],
					items: { type: "string" },
					description: "Optional action filters using any of: warning, kick, ban."
				},
				limit: {
					type: ["number", "null"],
					description: "Maximum number of tracked users to return."
				}
			},
			required: ["guildId", "actionFilter", "limit"],
			additionalProperties: false
		}
	},

	async execute({ guildId, actionFilter, limit }, context: ToolContext) {
		const access = await requireFullModerationAccess(context);
		if (!access.ok)
			return access;

		const guild = await resolveGuild(guildId, context);
		if (!guild)
			return { ok: false, error: "Không tìm thấy máy chủ hoặc máy chủ không khả dụng trong ngữ cảnh hiện tại." };

		const summary = listGuildModerationProfiles(guild.id, { actionFilter, limit });
		return {
			...summary,
			items: await enrichModerationUsers(summary.items)
		};
	}
};

const getModerationHistoryTool: Tool = {
	definition: {
		name: "get_moderation_history",
		description: "Retrieve the moderation history log for the guild, optionally filtered by user or action.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				guildId: {
					type: ["string", "null"],
					description: "Guild ID to query. If null, use the current guild."
				},
				userId: {
					type: ["string", "null"],
					description: "Optional target user ID to filter history."
				},
				action: {
					type: ["string", "null"],
					description: "Optional action filter: warning, clear_warnings, kick, ban, or delete_messages."
				},
				limit: {
					type: ["number", "null"],
					description: "Maximum number of history entries to return."
				}
			},
			required: ["guildId", "userId", "action", "limit"],
			additionalProperties: false
		}
	},

	async execute({ guildId, userId, action, limit }, context: ToolContext) {
		const access = await requireFullModerationAccess(context);
		if (!access.ok)
			return access;

		const guild = await resolveGuild(guildId, context);
		if (!guild)
			return { ok: false, error: "Không tìm thấy máy chủ hoặc máy chủ không khả dụng trong ngữ cảnh hiện tại." };

		const history = getModerationHistory(guild.id, { userId, action, limit });
		return {
			...history,
			items: await enrichModerationUsers(history.items)
		};
	}
};

/**
 * Moderation tools, offered to the model only when the bot has full
 * moderation access in the current context (see registry gating).
 */
export const moderationTools: Tool[] = [
	issueWarningTool,
	clearUserWarningsTool,
	deleteMessagesTool,
	kickUserTool,
	banUserTool,
	queryGuildModerationTool,
	getModerationHistoryTool
];
