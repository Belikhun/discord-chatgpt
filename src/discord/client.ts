import { Client, GatewayIntentBits, Partials, type Channel, type Guild, type User } from "discord.js";
import { log } from "../logger";
import { env } from "../env";

//* ===========================================================
//*  Initialize client
//* -----------------------------------------------------------
//*  Start initializing our discord client.
//*  https://discordjs.guide/
//* ===========================================================

log.debug("Khởi tạo discord client.");

export const discord = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMembers,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
		GatewayIntentBits.DirectMessages,
		GatewayIntentBits.DirectMessageTyping,
		GatewayIntentBits.DirectMessageReactions
	],

	partials: [Partials.Channel]
});

export async function authenticateDiscordClient(): Promise<void> {
	await discord.login(env.DISCORD_TOKEN);
}

/**
 * Get discord channel by ID.
 * Will try to get from cache first. If not exist, fetch from Discord.
 */
export async function getChannel(id: string): Promise<Channel | null> {
	let channel: Channel | null | undefined = discord.channels.cache.get(id);

	if (!channel)
		channel = await discord.channels.fetch(id);

	return channel ?? null;
}

/**
 * Get discord user by ID.
 * Will try to get from cache first. If not exist, fetch from Discord.
 */
export async function getUser(id: string): Promise<User> {
	let user = discord.users.cache.get(id);

	if (!user)
		user = await discord.users.fetch(id);

	return user;
}

/**
 * Get discord guild by ID.
 * Will try to get from cache first. If not exist, fetch from Discord.
 */
export async function getGuild(id: string): Promise<Guild> {
	let guild = discord.guilds.cache.get(id);

	if (!guild)
		guild = await discord.guilds.fetch(id);

	return guild;
}
