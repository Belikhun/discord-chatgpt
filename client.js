import { Client, GatewayIntentBits, User, TextChannel, Partials, Guild } from "discord.js";
import { log } from "./logger.js";


//* ===========================================================
//*  Initialize client
//* -----------------------------------------------------------
//*  Start initializing our discord client.
//*  https://discordjs.guide/
//* ===========================================================

log.debug("Khởi tạo discord client.");

export const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
		GatewayIntentBits.DirectMessages,
		GatewayIntentBits.DirectMessageTyping,
		GatewayIntentBits.DirectMessageReactions
	],

	partials: [Partials.Channel]
});

/**
 * Get discord channel by ID.
 * Will try to get from cache first. If not exist, fetch from Discord.
 * 
 * @param	{String}				id
 * @returns	{Promise<TextChannel>}
 */
export async function getChannel(id) {
	let channel = client.channels.cache.get(id);

	if (!channel)
		channel = await client.channels.fetch(id);

	return channel;
}

/**
 * Get discord user by ID.
 * Will try to get from cache first. If not exist, fetch from Discord.
 * 
 * @param	{String}			id
 * @returns	{Promise<User>}
 */
export async function getUser(id) {
	let channel = client.users.cache.get(id);

	if (!channel)
		channel = await client.users.fetch(id);

	return channel;
}

/**
 * Get discord guild by ID.
 * Will try to get from cache first. If not exist, fetch from Discord.
 * 
 * @param	{String}			id
 * @returns	{Promise<Guild>}
 */
export async function getGuild(id) {
	let channel = client.guilds.cache.get(id);

	if (!channel)
		channel = await client.guilds.fetch(id);

	return channel;
}
