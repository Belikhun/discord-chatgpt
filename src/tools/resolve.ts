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
 * Resolve the guild a tool may act on.
 *
 * A model-supplied guild ID is only honoured when it is the conversation's own
 * guild, or, in a DM, a guild the person talking is a member of. Without that
 * fence a conversation in one server could read another server's memories,
 * members or moderation history just by naming its ID.
 */
export async function resolveGuild(guildId: string | null | undefined, context: ToolContext): Promise<Guild | null> {
	const current: Guild | null = (context?.conversation?.channel as any)?.guild || null;

	if (!guildId || guildId === current?.id)
		return current;

	if (current)
		return null;

	const authorId = context?.message?.author?.id;
	if (!authorId)
		return null;

	const guild = await getGuild(guildId).catch(() => null);
	if (!guild)
		return null;

	const member = await guild.members.fetch(authorId).catch(() => null);
	return member ? guild : null;
}
