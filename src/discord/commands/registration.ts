import { REST, Routes } from "discord.js";
import { interactive } from "../../logger";
import { env } from "../../env";
import { discord } from "../client";
import { buildCommands, buildGlobalCommands } from "./builders";

// Construct and prepare an instance of the REST module
const rest = new REST().setToken(env.DISCORD_TOKEN);

/**
 * Register global commands (available in personal app contexts).
 */
export async function registerGlobalCommands(): Promise<any> {
	const log = interactive("commands");
	const commandsJSON = buildGlobalCommands();

	try {
		log.await(`Bắt đầu đăng ký ${commandsJSON.length} câu lệnh toàn cục.`);

		const data: any = await rest.put(
			Routes.applicationCommands(env.APP_ID),
			{ body: commandsJSON }
		);

		log.success(`Đã đăng ký thành công ${data.length} câu lệnh toàn cục.`);
		return data;
	} catch (error) {
		log.error(error);
		throw error;
	}
}

/**
 * Register commands to a specific guild (fast propagation).
 */
export async function registerCommandsToGuild(guildId: string): Promise<any> {
	const log = interactive("commands");
	const commandsJSON = buildCommands();

	try {
		log.await(`Bắt đầu đăng ký ${commandsJSON.length} câu lệnh cho guild ${guildId}.`);

		const data: any = await rest.put(
			Routes.applicationGuildCommands(env.APP_ID, guildId),
			{ body: commandsJSON }
		);

		log.success(`Đã đăng ký thành công ${data.length} câu lệnh cho guild ${guildId}.`);
		return data;
	} catch (error) {
		log.error(error);
		throw error;
	}
}

export async function syncCommandsToAllGuilds(): Promise<void> {
	const log = interactive("commands");
	const guilds = await discord.guilds.fetch();

	if (guilds.size === 0) {
		log.await("Bot hiện chưa ở guild nào, không có commands để đồng bộ.");
		return;
	}

	log.await(`Đang đồng bộ commands tới ${guilds.size} guild hiện có.`);
	for (const guild of guilds.values()) {
		try {
			await registerCommandsToGuild(guild.id);
		} catch (e: any) {
			log.error(`Không thể đồng bộ commands cho guild ${guild.id}: ${e.message}`);
		}
	}

	log.success(`Đã hoàn tất đồng bộ commands cho ${guilds.size} guild.`);
}
