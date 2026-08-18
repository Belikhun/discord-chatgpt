import { Events } from "discord.js";
import { log, interactive } from "../../logger";
import { discord } from "../client";
import { registerCommandsToGuild, registerGlobalCommands, syncCommandsToAllGuilds } from "../commands/registration";
import { handleChatInputCommand } from "../commands/handlers";
import { handleAutocomplete } from "../commands/autocomplete";
import { handleMessageCreate } from "./messageCreate";
import { handleGuildMemberAdd } from "./guildMemberAdd";

/**
 * Register all discord client event handlers.
 */
export function registerEvents(): void {
	// When the bot joins a new guild, register the commands for that guild so
	// they are immediately available (fast, guild-scoped registration).
	discord.on(Events.GuildCreate, async (guild) => {
		const log = interactive("commands");
		try {
			await registerCommandsToGuild(guild.id);
			log.success(`Commands đã được đăng ký cho guild ${guild.id} (${guild.name}).`);
		} catch (e: any) {
			log.error(`Không thể đăng ký commands cho guild ${guild.id}: ${e.message}`);
		}
	});

	discord.on(Events.ClientReady, async () => {
		log.success(`Đã đăng nhập dưới tài khoản ${discord.user!.tag}!`);

		try {
			await registerGlobalCommands();
		} catch (err: any) {
			log.error(`Không thể đăng ký global commands khi khởi động: ${err.message}`);
		}

		try {
			await syncCommandsToAllGuilds();
		} catch (err: any) {
			log.error(`Không thể đồng bộ commands khi khởi động: ${err.message}`);
		}
	});

	discord.on("error", (err) => {
		log.error(`Discord client error: ${err?.message || err}`);
	});

	discord.on(Events.MessageUpdate, async (message) => {

	});

	discord.on(Events.GuildMemberAdd, handleGuildMemberAdd);

	discord.on(Events.InteractionCreate, async (interaction) => {
		if (interaction.isAutocomplete()) {
			await handleAutocomplete(interaction);
			return;
		}

		if (!interaction.isChatInputCommand())
			return;

		await handleChatInputCommand(interaction);
	});

	discord.on(Events.MessageCreate, handleMessageCreate);
}
