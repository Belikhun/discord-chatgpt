import { Client, GatewayIntentBits, User, TextChannel, Partials, Guild } from "discord.js";
import { log } from "../logger.js";

import env from "../env.json" assert { type: "json" };
const { DISCORD_TOKEN } = env;

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
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
		GatewayIntentBits.DirectMessages,
		GatewayIntentBits.DirectMessageTyping,
		GatewayIntentBits.DirectMessageReactions
	],

	partials: [Partials.Channel]
});

export async function authenticateDiscordClient() {
	await discord.login(DISCORD_TOKEN);
}

/**
 * Get discord channel by ID.
 * Will try to get from cache first. If not exist, fetch from Discord.
 * 
 * @param	{String}				id
 * @returns	{Promise<TextChannel>}
 */
export async function getChannel(id) {
	let channel = discord.channels.cache.get(id);

	if (!channel)
		channel = await discord.channels.fetch(id);

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
	let channel = discord.users.cache.get(id);

	if (!channel)
		channel = await discord.users.fetch(id);

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
	let channel = discord.guilds.cache.get(id);

	if (!channel)
		channel = await discord.guilds.fetch(id);

	return channel;
}

export default {
	discord,
	authenticateDiscordClient
}
