import type { Guild } from "discord.js";
import { getChannel, getGuild } from "../discord/client";
import type { ToolContext } from "./types";

/**
 * Resolve a channel by ID, falling back to the conversation's channel.
 */
export async function resolveChannel(channelId: string | null | undefined, context: ToolContext): Promise<any> {
	if (channelId)
		return await getChannel(channelId);

	return context?.conversation?.channel || null;
}

/**
 * Resolve a guild by ID, falling back to the conversation channel's guild.
 */
export async function resolveGuild(guildId: string | null | undefined, context: ToolContext): Promise<Guild | null> {
	if (guildId)
		return await getGuild(guildId);

	return (context?.conversation?.channel as any)?.guild || null;
}
