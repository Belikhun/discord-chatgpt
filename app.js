import { Events, REST, Routes, EmbedBuilder, SlashCommandBuilder, Message, DMChannel, Guild, User, PermissionsBitField } from "discord.js";
import { log, interactive } from "./logger.js";
import { discord, authenticateDiscordClient } from "./clients/discord.js";
import { bold, code, emoji } from "./format.js";
import config from "./config/config.js";
import { ChatConversation } from "./objects/ChatConversation.js";

import { models } from "./clients/openai.js";
import env from "./env.json" with { type: "json" };
const {
	DISCORD_TOKEN,
	APP_ID,
	GUILD_ID,
	APP_NAME,
	ICON,
	WAKEUP_KEYWORDS,
	SYSTEM_ROLE_CHANNEL,
	SYSTEM_ROLE_SERVER,
	SYSTEM_ROLE_SERVER_ASSISTANT,
	SYSTEM_ROLE_MODEL,
	SYSTEM_ROLE_CHAT,
	SYSTEM_ROLE_ASSISTANT,
	MODEL_DEFAULT,
	NICKNAME_DEFAULT,
	WELCOME_INSTRUCTION_DEFAULT,
	WELCOME_INSTRUCTION_SERVER
} = env;

/** @type {{[channelId: string]: ChatConversation}} */
const conversations = {};

//* ===========================================================
//*  Register commands
//* -----------------------------------------------------------
//*  Build commands once and provide helpers to register them
//*  to a guild. Also register commands automatically when
//*  the bot joins a new guild via the GuildCreate event.
//* ===========================================================

// Construct and prepare an instance of the REST module
const rest = new REST().setToken(DISCORD_TOKEN);

// Build the commands (JSON) used by the Discord API
function buildCommands() {
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

		new SlashCommandBuilder()
			.setName("nickname")
			.setDescription("Đặt nickname cho bot trong máy chủ hiện tại")
			.addStringOption((option) => {
				return option.setName("name")
					.setDescription("Nickname mới cho bot")
					.setRequired(true);
			}),
	];

	// Convert builders to plain JSON for the REST API
	return commands.map((c) => c.toJSON());
}

// Register commands to a specific guild (fast propagation)
async function registerCommandsToGuild(guildId) {
	const log = interactive("commands");
	const commandsJSON = buildCommands();

	try {
		log.await(`Bắt đầu đăng ký ${commandsJSON.length} câu lệnh cho guild ${guildId}.`);

		const data = await rest.put(
			Routes.applicationGuildCommands(APP_ID, guildId),
			{ body: commandsJSON }
		);

		log.success(`Đã đăng ký thành công ${data.length} câu lệnh cho guild ${guildId}.`);
		return data;
	} catch (error) {
		log.error(error);
		throw error;
	}
}

// At startup: if a dev/test GUILD_ID is provided, register commands there
(async () => {
	const log = interactive("commands");

	if (GUILD_ID) {
		try {
			await registerCommandsToGuild(GUILD_ID);
		} catch (e) {
			log.error(`Không thể đăng ký lệnh cho GUILD_ID=${GUILD_ID}: ${e.message}`);
		}
	} else {
		log.await("GUILD_ID không được cấu hình, bỏ qua đăng ký lệnh tại khởi động. Commands sẽ được đăng ký khi bot vào guild mới.");
	}
})();

// When the bot joins a new guild, register the commands for that guild so
// they are immediately available (fast, guild-scoped registration).
discord.on(Events.GuildCreate, async (guild) => {
	const log = interactive("commands");
	try {
		await registerCommandsToGuild(guild.id);
		log.success(`Commands đã được đăng ký cho guild ${guild.id} (${guild.name}).`);
	} catch (e) {
		log.error(`Không thể đăng ký commands cho guild ${guild.id}: ${e.message}`);
	}
});


//* ===========================================================
//*  Register events
//* -----------------------------------------------------------
//*  Register client events to handle user messages and 
//*  commands.
//* ===========================================================

/**
 * Check if the user has Manage Messages permission in the guild.
 * 
 * @param	{Guild}		guild
 * @param	{User}		user
 * @returns 
 */
function hasManagePermission(guild, user) {
	return guild.members.cache.get(user.id)?.permissions.has("ManageMessages") || false;
}

function buildErrorEmbed(error, { actorName, actorIcon } = {}) {
	const embed = new EmbedBuilder()
		.setColor(0xff6380)
		.setTitle(`${emoji("acerror")}  Có lỗi nghiêm trọng đã xảy ra!`)
		.setDescription(`${bold(error.name || "Error")} ${error.message}\n\`\`\`${error.stack}\`\`\``)
		.setTimestamp()
		.setFooter({ text: APP_NAME, iconURL: ICON });

	if (actorName || actorIcon) {
		embed.setAuthor({
			name: actorName,
			iconURL: actorIcon
		});
	}

	return embed;
}

function resolveConversation(channel, { modeOverride } = {}) {
	if (conversations[channel.id])
		return conversations[channel.id];

	const model = config.get(`model.${channel.id}`, MODEL_DEFAULT);
	const mode = modeOverride ?? config.get(`mode.${channel.id}`, (channel instanceof DMChannel) ? "assistant" : "chat");

	let instructions;

	if (mode === "chat") {
		if (typeof SYSTEM_ROLE_CHANNEL[channel.id] !== "undefined") {
			instructions = SYSTEM_ROLE_CHANNEL[channel.id];
		} else if (channel.guild && typeof SYSTEM_ROLE_SERVER[channel.guild.id] !== "undefined") {
			instructions = SYSTEM_ROLE_SERVER[channel.guild.id];
		} else if (typeof SYSTEM_ROLE_MODEL[model] !== "undefined") {
			instructions = SYSTEM_ROLE_MODEL[model];
		} else {
			instructions = SYSTEM_ROLE_CHAT;
		}
	} else {
		if (channel.guild && typeof SYSTEM_ROLE_SERVER_ASSISTANT[channel.guild.id] !== "undefined") {
			instructions = SYSTEM_ROLE_SERVER_ASSISTANT[channel.guild.id];
		} else {
			instructions = SYSTEM_ROLE_ASSISTANT;
		}
	}

	const nicknames = config.get("nicknames", {});
	const conversation = new ChatConversation(channel, model, instructions, mode, {
		nickname: nicknames[channel.guild?.id] || NICKNAME_DEFAULT
	});

	conversation.conversationWakeupKeywords = WAKEUP_KEYWORDS;
	conversations[channel.id] = conversation;

	return conversation;
}

function pickWelcomeChannel(guild) {
	if (!guild)
		return null;

	const canSend = (channel) => channel.isTextBased()
		&& channel.viewable
		&& channel.permissionsFor(guild.members.me ?? guild.client.user)?.has(PermissionsBitField.Flags.SendMessages);

	if (guild.systemChannel && canSend(guild.systemChannel))
		return guild.systemChannel;

	return guild.channels.cache.find((channel) => canSend(channel)) || null;
}

discord.on(Events.ClientReady, () => {
	log.success(`Đã đăng nhập dưới tài khoản ${discord.user.tag}!`);
});

discord.on("error", (err) => {
	log.error(`Discord client error: ${err?.message || err}`);
});

discord.on(Events.MessageUpdate, async (message) => {
	
});

discord.on(Events.GuildMemberAdd, async (member) => {
	const channel = pickWelcomeChannel(member.guild);
	log.info(`Người dùng mới tham gia guild ${member.guild.id}, chọn kênh ${channel?.id || "null"} để gửi lời chào.`);

	if (!channel) {
		log.warn(`Không tìm thấy kênh phù hợp để chào mừng thành viên mới trong guild ${member.guild.id}.`);
		return;
	}

	const conversation = resolveConversation(channel);
	const welcomeTemplate = (WELCOME_INSTRUCTION_SERVER?.[member.guild.id])
		|| WELCOME_INSTRUCTION_DEFAULT
		|| "New member joined: <@{userId}> just joined {serverName}. Welcome them warmly, mention them directly, and share a quick tip about this server.";

	const welcomeMessage = welcomeTemplate
		.replaceAll("{userId}", member.user.id)
		.replaceAll("{username}", member.user.username)
		.replaceAll("{displayName}", member.displayName || member.user.username)
		.replaceAll("{serverName}", member.guild.name)
		.replaceAll("{channelName}", channel.name || "");
	const structuredWelcome = {
		currentChannel: { id: channel.id, name: channel.name },
		messageAuthor: {
			id: member.user.id,
			username: member.user.username,
			displayName: member.displayName || member.user.username
		},
		message: welcomeMessage,
		event: "guild_member_join"
	};

	try {
		await conversation.handleStructuredPrompt(structuredWelcome, { activateChat: true, role: "developer" });
	} catch (e) {
		log.error(`Không thể gửi lời chào cho thành viên mới ${member.user.tag}: ${e.message}`);

		try {
			await channel.send(`${emoji("acerror")} Bot thiếu quyền gửi tin nhắn ở kênh này.`);
		} catch (sendErr) {
			log.error(`Không thể gửi thông báo lỗi trong kênh ${channel.id}: ${sendErr.message}`);
		}
	}
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
				if (!hasManagePermission(interaction.guild, interaction.user)) {
					await interaction.reply({
						content: `${emoji("acerror")} Bạn cần có quyền Quản lý tin nhắn để sử dụng lệnh này!`,
						ephemeral: true
					});

					return;
				}

				const model = interaction.options.getString("model", true);
				conversations[interaction.channelId] = null;
				config.set(`model.${interaction.channelId}`, model);

				await interaction.reply({
					content: `${emoji("acinfo")} Model cho kênh chat này đã được đặt thành ${code(model)}!`
				});

				break;
			}

			case "mode": {
				if (!hasManagePermission(interaction.guild, interaction.user)) {
					await interaction.reply({
						content: `${emoji("acerror")} Bạn cần có quyền Quản lý tin nhắn để sử dụng lệnh này!`,
						ephemeral: true
					});

					return;
				}

				const mode = interaction.options.getString("mode", true);
				conversations[interaction.channelId] = null;
				config.set(`mode.${interaction.channelId}`, mode);

				await interaction.reply({
					content: `${emoji("acinfo")} Chế độ phản hồi cho kênh hiện tại được đặt thành ${code(mode)}!`
				});

				break;
			}

			case "nickname": {
				if (!hasManagePermission(interaction.guild, interaction.user)) {
					await interaction.reply({
						content: `${emoji("acerror")} Bạn cần có quyền Quản lý tin nhắn để sử dụng lệnh này!`,
						ephemeral: true
					});

					return;
				}

				const name = interaction.options.getString("name", true);

				if (!interaction.guild) {
					await interaction.reply({
						content: `${emoji("acerror")} Lệnh này chỉ có thể sử dụng trong máy chủ!`,
						ephemeral: true
					});

					return;
				}
				
				const nicknames = config.get("nicknames", {});
				nicknames[interaction.guild.id] = name;
				config.set("nicknames", nicknames);

				await interaction.reply({
					content: `${emoji("acinfo")} Nickname của bot trong máy chủ này đã được đặt thành ${code(name)}!`
				});

				break;
			}
		
			default: {
				log.error(`Không tìm thấy câu lệnh ${interaction.commandName}.`);
				return;
			}
		}
	} catch (e) {
		const embed = buildErrorEmbed(e, {
			actorName: interaction.user.displayName,
			actorIcon: interaction.user.displayAvatarURL()
		});

		log.error(e);

		try {
			if (interaction.replied || interaction.deferred) {
				await interaction.followUp({ embeds: [embed], ephemeral: true });
			} else {
				await interaction.reply({ embeds: [embed], ephemeral: true });
			}
		} catch (sendErr) {
			log.error(`Failed to send interaction error response: ${sendErr.message}`);
		}
	}
});

discord.on(Events.MessageCreate, async (message) => {
	// if (message.author.bot)
	// 	return;
	if (message.author.id === discord.user.id)
		return;

	if (!message.content && !message.attachments.size && !message.components.length)
		return;

	if (message.content.startsWith("*clear") || message.content.startsWith("/clear")) {
		const count = conversations[message.channelId]?.history.length || 0;
		conversations[message.channelId] = null;

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
		const conversation = resolveConversation(message.channel);
		await conversation.handle(message);
	} catch (e) {
		const embed = buildErrorEmbed(e, {
			actorName: message.author.displayName,
			actorIcon: message.author.displayAvatarURL()
		});

		log.error(e);

		try {
			await message.reply({ embeds: [embed] });
		} catch (sendErr) {
			log.error(`Failed to send error embed in channel ${message.channelId}: ${sendErr.message}`);
		}
	}
});


//* ===========================================================
//*  Bring the bot online
//* -----------------------------------------------------------
//*  Login to the bot and make it online.
//* ===========================================================

await authenticateDiscordClient();
