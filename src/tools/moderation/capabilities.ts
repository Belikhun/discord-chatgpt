import { PermissionsBitField, type GuildMember } from "discord.js";
import { discord } from "../../discord/client";
import type { ToolContext } from "../types";

export interface ModerationCapabilities {
	available: boolean;
	fullModerationAccess: boolean;
	guildId: string | null;
	channelId: string | null;
	canSend: boolean;
	canDeleteMessages: boolean;
	canKickMembers: boolean;
	canBanMembers: boolean;
	missingPermissions: string[];
	reason: string | null;
	botMember?: GuildMember | null;
}

export async function getModerationCapabilities(context: ToolContext = {}): Promise<ModerationCapabilities> {
	if (context.moderationCapabilities)
		return context.moderationCapabilities;

	const channel: any = context?.message?.channel || context?.conversation?.channel || null;
	const guild: any = context?.message?.guild || (context?.conversation?.channel as any)?.guild || null;
	const unavailable: ModerationCapabilities = {
		available: false,
		fullModerationAccess: false,
		guildId: guild?.id || null,
		channelId: channel?.id || null,
		canSend: false,
		canDeleteMessages: false,
		canKickMembers: false,
		canBanMembers: false,
		missingPermissions: ["guild_context"],
		reason: "Guild text channel context is required."
	};

	if (!guild || !channel?.isTextBased?.()) {
		context.moderationCapabilities = unavailable;
		return unavailable;
	}

	let botMember: GuildMember | null = guild.members.me;
	if (!botMember) {
		try {
			botMember = await guild.members.fetchMe();
		} catch (err) {
			botMember = null;
		}
	}

	const channelPermissions = channel.permissionsFor(botMember || discord.user);
	const canSend = Boolean(channelPermissions?.has(PermissionsBitField.Flags.SendMessages));
	const canDeleteMessages = Boolean(channelPermissions?.has(PermissionsBitField.Flags.ManageMessages));
	const canKickMembers = Boolean(botMember?.permissions.has(PermissionsBitField.Flags.KickMembers));
	const canBanMembers = Boolean(botMember?.permissions.has(PermissionsBitField.Flags.BanMembers));
	const missingPermissions: string[] = [];

	if (!canSend)
		missingPermissions.push("SendMessages");
	if (!canDeleteMessages)
		missingPermissions.push("ManageMessages");
	if (!canKickMembers)
		missingPermissions.push("KickMembers");
	if (!canBanMembers)
		missingPermissions.push("BanMembers");

	const capabilities: ModerationCapabilities = {
		available: true,
		fullModerationAccess: missingPermissions.length === 0,
		guildId: guild.id,
		channelId: channel.id,
		canSend,
		canDeleteMessages,
		canKickMembers,
		canBanMembers,
		missingPermissions,
		reason: missingPermissions.length === 0
			? null
			: `Missing permissions: ${missingPermissions.join(", ")}`,
		botMember
	};

	context.moderationCapabilities = capabilities;
	return capabilities;
}

export async function requireFullModerationAccess(context: ToolContext = {}): Promise<{ ok: true; capabilities: ModerationCapabilities } | { ok: false; error: string }> {
	const capabilities = await getModerationCapabilities(context);
	if (capabilities.fullModerationAccess)
		return { ok: true, capabilities };

	return {
		ok: false,
		error: capabilities.reason || "Các công cụ kiểm duyệt không khả dụng trong ngữ cảnh hiện tại."
	};
}
