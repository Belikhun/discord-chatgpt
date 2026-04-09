import { Events, REST, Routes, EmbedBuilder, SlashCommandBuilder, Message, DMChannel, Guild, User, PermissionsBitField, ChannelType } from "discord.js";
import { log, interactive } from "./logger.js";
import { discord, authenticateDiscordClient } from "./clients/discord.js";
import { bold, code, emoji } from "./format.js";
import config from "./config/config.js";
import { ChatConversation } from "./objects/ChatConversation.js";
import { getConversation, setConversation } from "./store/conversation.js";

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

// Conversations are stored in a shared registry (conversationStore).
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
			.setName("reasoning")
			.setDescription("Đặt mức độ suy luận cho model ở kênh hiện tại")
			.addStringOption((option) => {
				return option.setName("effort")
					.setDescription("Mức độ suy luận sẽ dùng cho các model hỗ trợ reasoning")
					.setRequired(true)
					.addChoices(
						{ name: "Tối thiểu", value: "minimal" },
						{ name: "Thấp", value: "low" },
						{ name: "Trung bình", value: "medium" },
						{ name: "Cao", value: "high" }
					);
			}),

		new SlashCommandBuilder()
			.setName("blacklist")
			.setDescription("Quản lý danh sách chặn bot theo kênh")
			.addChannelOption((option) => {
				return option
					.setName("channel")
					.setDescription("Kênh cần chặn. Nếu bỏ trống sẽ dùng kênh hiện tại.")
					.setRequired(false)
					.addChannelTypes(
						ChannelType.GuildText,
						ChannelType.GuildAnnouncement,
						ChannelType.PublicThread,
						ChannelType.PrivateThread
					);
			}),

		new SlashCommandBuilder()
			.setName("blacklist_remove")
			.setDescription("Gỡ chặn bot phản hồi trong một kênh văn bản")
			.addChannelOption((option) => {
				return option
					.setName("channel")
					.setDescription("Kênh cần gỡ chặn. Nếu bỏ trống sẽ dùng kênh hiện tại.")
					.setRequired(false)
					.addChannelTypes(
						ChannelType.GuildText,
						ChannelType.GuildAnnouncement,
						ChannelType.PublicThread,
						ChannelType.PrivateThread
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

async function syncCommandsToAllGuilds() {
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
		} catch (e) {
			log.error(`Không thể đồng bộ commands cho guild ${guild.id}: ${e.message}`);
		}
	}

	log.success(`Đã hoàn tất đồng bộ commands cho ${guilds.size} guild.`);
}

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

function getBlacklistedChannels() {
	return config.get("channelBlacklist", {});
}

function isChannelBlacklisted(channelId) {
	return Boolean(getBlacklistedChannels()?.[channelId]);
}

function setChannelBlacklist(channelId, blacklisted) {
	const channels = { ...getBlacklistedChannels() };

	if (blacklisted)
		channels[channelId] = true;
	else
		delete channels[channelId];

	config.set("channelBlacklist", channels);
}

function resolveBlacklistTargetChannel(interaction) {
	const channel = interaction.options.getChannel("channel") || interaction.channel;
	if (!channel)
		return null;

	if (!channel.guildId || !channel.isTextBased?.())
		return null;

	return channel;
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

function applyMemorySummary(conversation) {
	const guildId = conversation?.channel?.guild?.id;
	if (!guildId)
		return;

	const summaries = config.get("memorySummaries", {});
	const summary = summaries?.[guildId];
	if (!summary)
		return;

	const history = Array.isArray(conversation.history) ? conversation.history : [];
	const prefix = "Memory summary:";
	const text = `${prefix}\n${summary}`;

	const isSummaryEntry = (entry) => {
		if (!entry || entry.role !== "developer")
			return false;

		const content = Array.isArray(entry.content)
			? entry.content.map((part) => part?.text || "").join("\n")
			: (entry.content || "");
		return content.startsWith(prefix);
	};

	const existingIndex = history.findIndex(isSummaryEntry);
	if (existingIndex >= 0)
		history.splice(existingIndex, 1);

	history.unshift({
		role: "developer",
		content: [{ type: "input_text", text }],
		timestamp: Date.now()
	});

	conversation.history = history;
}

function resolveConversation(channel, { modeOverride } = {}) {
	const existing = getConversation(channel.id);
	if (existing)
		return existing;

	const model = config.get(`model.${channel.id}`, MODEL_DEFAULT);
	const mode = modeOverride ?? config.get(`mode.${channel.id}`, (channel instanceof DMChannel) ? "assistant" : "chat");
	const reasoningEffort = config.get(`reasoning.${channel.id}`, "medium") || "medium";

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
		nickname: nicknames[channel.guild?.id] || NICKNAME_DEFAULT,
		reasoningEffort
	});

	conversation.conversationWakeupKeywords = WAKEUP_KEYWORDS;
	applyMemorySummary(conversation);
	setConversation(channel.id, conversation);

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

discord.on(Events.ClientReady, async () => {
	log.success(`Đã đăng nhập dưới tài khoản ${discord.user.tag}!`);

	try {
		await syncCommandsToAllGuilds();
	} catch (err) {
		log.error(`Không thể đồng bộ commands khi khởi động: ${err.message}`);
	}
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

	const welcomePayload = {
		type: "welcome",
		template: welcomeTemplate,
		data: {
			userId: member.user.id,
			username: member.user.username,
			displayName: member.displayName || member.user.username,
			serverName: member.guild.name,
			channelName: channel.name || ""
		},
		rules: [
			`Mention the member explicitly as <@${member.user.id}>`,
			"Keep it to one or two sentences.",
			"Include one quick tip about the server if possible.",
			"Reply in plain text only."
		]
	};
	const structuredWelcome = {
		currentChannel: { id: channel.id, name: channel.name },
		messageAuthor: {
			id: member.user.id,
			username: member.user.username,
			displayName: member.displayName || member.user.username
		},
		message: JSON.stringify(welcomePayload),
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
				const count = getConversation(interaction.channelId)?.history.length || 0;
				setConversation(interaction.channelId, null);

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
				setConversation(interaction.channelId, null);
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
				setConversation(interaction.channelId, null);
				config.set(`mode.${interaction.channelId}`, mode);

				await interaction.reply({
					content: `${emoji("acinfo")} Chế độ phản hồi cho kênh hiện tại được đặt thành ${code(mode)}!`
				});

				break;
			}

			case "reasoning": {
				if (!hasManagePermission(interaction.guild, interaction.user)) {
					await interaction.reply({
						content: `${emoji("acerror")} Bạn cần có quyền Quản lý tin nhắn để sử dụng lệnh này!`,
						ephemeral: true
					});

					return;
				}

				const effort = interaction.options.getString("effort", true);
				setConversation(interaction.channelId, null);
				config.set(`reasoning.${interaction.channelId}`, effort);

				await interaction.reply({
					content: `${emoji("acinfo")} Mức độ suy luận cho kênh hiện tại đã được đặt thành ${code(effort)}. Thiết lập này sẽ được dùng khi kênh sử dụng model hỗ trợ reasoning.`
				});

				break;
			}

			case "blacklist": {
				if (!interaction.guild) {
					await interaction.reply({
						content: `${emoji("acerror")} Lệnh này chỉ có thể sử dụng trong máy chủ!`,
						ephemeral: true
					});

					return;
				}

				if (!hasManagePermission(interaction.guild, interaction.user)) {
					await interaction.reply({
						content: `${emoji("acerror")} Bạn cần có quyền Quản lý tin nhắn để sử dụng lệnh này!`,
						ephemeral: true
					});

					return;
				}

				const targetChannel = resolveBlacklistTargetChannel(interaction);
				if (!targetChannel) {
					await interaction.reply({
						content: `${emoji("acerror")} Chỉ có thể blacklist các kênh văn bản trong máy chủ.`,
						ephemeral: true
					});

					return;
				}

				if (isChannelBlacklisted(targetChannel.id)) {
					await interaction.reply({
						content: `${emoji("acinfo")} Kênh <#${targetChannel.id}> đã nằm trong blacklist rồi.`
					});

					return;
				}

				setChannelBlacklist(targetChannel.id, true);
				setConversation(targetChannel.id, null);

				await interaction.reply({
					content: `${emoji("acinfo")} Bot sẽ ngừng phản hồi trong kênh <#${targetChannel.id}> cho tới khi được gỡ khỏi blacklist.`
				});

				break;
			}

			case "blacklist_remove": {
				if (!interaction.guild) {
					await interaction.reply({
						content: `${emoji("acerror")} Lệnh này chỉ có thể sử dụng trong máy chủ!`,
						ephemeral: true
					});

					return;
				}

				if (!hasManagePermission(interaction.guild, interaction.user)) {
					await interaction.reply({
						content: `${emoji("acerror")} Bạn cần có quyền Quản lý tin nhắn để sử dụng lệnh này!`,
						ephemeral: true
					});

					return;
				}

				const targetChannel = resolveBlacklistTargetChannel(interaction);
				if (!targetChannel) {
					await interaction.reply({
						content: `${emoji("acerror")} Chỉ có thể gỡ blacklist cho các kênh văn bản trong máy chủ.`,
						ephemeral: true
					});

					return;
				}

				if (!isChannelBlacklisted(targetChannel.id)) {
					await interaction.reply({
						content: `${emoji("acinfo")} Kênh <#${targetChannel.id}> hiện không nằm trong blacklist.`
					});

					return;
				}

				setChannelBlacklist(targetChannel.id, false);

				await interaction.reply({
					content: `${emoji("acinfo")} Đã gỡ kênh <#${targetChannel.id}> khỏi blacklist. Bot có thể phản hồi lại trong kênh này.`
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

	if (message.guild && isChannelBlacklisted(message.channelId)) {
		log.debug(`Bỏ qua tin nhắn trong kênh blacklist ${message.channelId}.`);
		return;
	}

	if (!message.content && !message.attachments.size && !message.components.length)
		return;

	if (message.content.startsWith("*clear") || message.content.startsWith("/clear")) {
		const count = getConversation(message.channelId)?.history.length || 0;
		setConversation(message.channelId, null);

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
