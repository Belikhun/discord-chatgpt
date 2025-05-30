import { Events, REST, Routes, EmbedBuilder, SlashCommandBuilder, Message, DMChannel } from "discord.js";
import { log, interactive } from "./logger.js";
import { discord, authenticateDiscordClient } from "./clients/discord.js";
import { bold, code, emoji } from "./format.js";
import config from "./config/config.js";
import { ChatConversation } from "./objects/ChatConversation.js";

import { models } from "./clients/openai.js";
import env from "./env.json" with { type: "json" };
const { DISCORD_TOKEN, APP_ID, GUILD_ID, APP_NAME, ICON, SYSTEM_ROLE_CHANNEL, SYSTEM_ROLE_MODEL, SYSTEM_ROLE_CHAT, SYSTEM_ROLE_ASSISTANT, MODEL_DEFAULT } = env;

/** @type {{[channelId: string]: ChatConversation}} */
const conversations = {};

//* ===========================================================
//*  Register commands
//* -----------------------------------------------------------
//*  Register all commands manually, because this is just a
//*  simple bot, I don't think a complex command system is
//*  required.
//* ===========================================================

// Construct and prepare an instance of the REST module
const rest = new REST().setToken(DISCORD_TOKEN);

// and deploy your commands!
(async () => {
	const log = interactive("commands");

	const commands = [
		new SlashCommandBuilder()
			.setName("clear")
			.setDescription("Xóa toàn bộ context tin nhắn trong một kênh"),

		new SlashCommandBuilder()
			.setName("model")
			.setDescription("Đặt model sẽ sử dụng cho kênh hiện tại")
			.addStringOption((option) => {
				return option.setName("model")
					.setDescription("Tên model hiện tại được hỗ trợ bởi OpenAI")
					.setRequired(true)
					.addChoices(...models.map((i) => ({ name: i, value: i })));
			}),

		new SlashCommandBuilder()
			.setName("mode")
			.setDescription("Đặt chế độ trả lời tin nhắn")
			.addStringOption((option) => {
				return option.setName("mode")
					.setDescription("Chế độ phản hồi")
					.setRequired(true)
					.addChoices(
						{ name: "Tin nhắn", value: "chat" },
						{ name: "Trợ lý", value: "assistant" }
					);
			}),
	];

	try {
		log.await(`Bắt đầu đăng ký ${commands.length} câu lệnh máy chủ.`);

		// The put method is used to fully refresh all commands in the guild with the current set
		const data = await rest.put(
			Routes.applicationGuildCommands(APP_ID, GUILD_ID),
			{ body: commands },
		);

		log.success(`Đã đăng ký thành công ${data.length} câu lệnh.`);
	} catch (error) {
		// And of course, make sure you catch and log any errors!
		log.error(error);
	}
})();


//* ===========================================================
//*  Register events
//* -----------------------------------------------------------
//*  Register client events to handle user messages and 
//*  commands.
//* ===========================================================

discord.on(Events.ClientReady, () => {
	log.success(`Đã đăng nhập dưới tài khoản ${discord.user.tag}!`);
});

discord.on(Events.MessageUpdate, async (message) => {
	
});

discord.on(Events.InteractionCreate, async (interaction) => {
	if (!interaction.isChatInputCommand())
		return;

	try {
		switch (interaction.commandName) {
			case "clear": {
				const count = conversations[interaction.channelId]?.history.length || 0;
				conversations[interaction.channelId] = null;

				await interaction.reply({
					content: `${emoji("acinfo")} ${count} chat context ở trong kênh này đã được loại bỏ!`
				});
				break;
			}

			case "model": {
				const model = interaction.options.getString("model", true);
				conversations[interaction.channelId] = null;
				config.set(`model.${interaction.channelId}`, model);

				await interaction.reply({
					content: `${emoji("acinfo")} Model cho kênh chat này đã được đặt thành ${code(model)}!`
				});
				break;
			}

			case "mode": {
				const mode = interaction.options.getString("mode", true);
				conversations[interaction.channelId] = null;
				config.set(`mode.${interaction.channelId}`, mode);

				await interaction.reply({
					content: `${emoji("acinfo")} Chế độ phản hồi cho kênh hiện tại được đặt thành ${code(mode)}!`
				});
				break;
			}
		
			default: {
				log.error(`Không tìm thấy câu lệnh ${interaction.commandName}.`);
				return;
			}
		}
	} catch (e) {
		const embed = new EmbedBuilder()
			.setColor(0xff6380)
			.setTitle(`${emoji("acerror")}  Có lỗi nghiêm trọng đã xảy ra!`)
			.setDescription(`${bold(e.name)} ${e.message}\n\`\`\`${e.stack}\`\`\``)
			.setAuthor({
				name: interaction.user.displayName,
				iconURL: interaction.user.displayAvatarURL()
			})
			.setTimestamp()
			.setFooter({ text: APP_NAME, iconURL: ICON });
		
		log.error(e);

		if (interaction.replied || interaction.deferred) {
			await interaction.followUp({ embeds: [embed], ephemeral: true });
		} else {
			await interaction.reply({ embeds: [embed], ephemeral: true });
		}
	}
});

discord.on(Events.MessageCreate, async (message) => {
	if (message.author.bot)
		return;

	if (!message.content && !message.attachments.size)
		return;

	if (message.content.startsWith("*clear") || message.content.startsWith("/clear")) {
		const count = channelMessages[message.channelId]?.length || 0;
		channelMessages[message.channelId] = null;

		await message.reply({
			content: `${emoji("acinfo")} ${count} chat context ở trong kênh này đã được loại bỏ!`
		});

		return;
	}

	const channelName = (message.channel instanceof DMChannel)
		? `${message.author.displayName}'s DM`
		: message.channel.name;

	log.debug(`▼ Tin nhắn mới: \"${message.content}\" từ ${channelName} [${message.channelId}] bởi ${message.author.displayName} [${message.author.id}]`);

	try {
		if (!conversations[message.channelId]) {
			const model = config.get(`model.${message.channelId}`, MODEL_DEFAULT);
			const mode = config.get(`mode.${message.channelId}`, (message.channel instanceof DMChannel) ? "assistant" : "chat");

			let instructions;
			if (typeof SYSTEM_ROLE_CHANNEL[message.channelId] !== "undefined") {
				instructions = SYSTEM_ROLE_CHANNEL[message.channelId];
			} else if (typeof SYSTEM_ROLE_MODEL[model] !== "undefined") {
				instructions = SYSTEM_ROLE_MODEL[model];
			} else {
				instructions = (mode === "chat")
					? SYSTEM_ROLE_CHAT
					: SYSTEM_ROLE_ASSISTANT;
			}

			conversations[message.channelId] = new ChatConversation(message.channel, model, instructions, mode);
		}

		await conversations[message.channelId].handle(message);
	} catch (e) {
		const embed = new EmbedBuilder()
			.setColor(0xff6380)
			.setTitle(`${emoji("acerror")}  Có lỗi nghiêm trọng đã xảy ra!`)
			.setDescription(`${bold(e.name)} ${e.message}\n\`\`\`${e.stack}\`\`\``)
			.setAuthor({
				name: message.author.displayName,
				iconURL: message.author.displayAvatarURL()
			})
			.setTimestamp()
			.setFooter({ text: APP_NAME, iconURL: ICON });
		
		log.error(e);
		await message.reply({ embeds: [embed] });
	}
});


//* ===========================================================
//*  Bring the bot online
//* -----------------------------------------------------------
//*  Login to the bot and make it online.
//* ===========================================================

await authenticateDiscordClient();
