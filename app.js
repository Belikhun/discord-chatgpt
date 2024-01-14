import { Collection, Events, REST, Routes, EmbedBuilder, SlashCommandBuilder, Message, DMChannel } from "discord.js";
import env from "./env.json" assert { type: "json" };
import { log, interactive } from "./logger.js";
import { client, getGuild } from "./client.js";
import { bold, code, emoji, formatTime, h2, h3, lines, mention } from "./format.js";
import { ChatGPTAPI } from "chatgpt";
import config from "./config/config.js";

const { DISCORD_TOKEN, APP_ID, GUILD_ID, OPENAI_API_KEY, SYSTEM_ROLE, SYSTEM_ROLE_ALT, THINKING_MESSAGE, RESET_AFTER_IDLE, OPENAI_MODEL, APP_NAME, ICON } = env;

//* ===========================================================
//*  Define local variables
//* -----------------------------------------------------------
//*  Define some variables here to store the current state of
//*  the application.
//* ===========================================================

/** @type {{[channelId: String]: ChatGPTAPI}} */
const channelClient = {};

/** @type {{[channelId: String]: import("chatgpt").ChatMessage[]}} */
const channelMessages = {};

/**
 * Return the last item of an array.
 * 
 * @template	T
 * @param		{T[]}	array
 * @returns		{T}
 */
const last = (array) => {
	return (array.length > 0)
		? array[array.length - 1]
		: null;
}


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
			.setDescription("Xóa toàn bộ context tin nhắn trong một kênh."),

		new SlashCommandBuilder()
			.setName("alt")
			.setDescription("Sử dụng SYSTEM_ROLE_ALT thay vì SYSTEM_ROLE cho kênh hiện tại."),
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

client.on(Events.ClientReady, () => {
	log.success(`Đã đăng nhập dưới tài khoản ${client.user.tag}!`);
});

client.on(Events.MessageUpdate, async (message) => {
	
});

client.on(Events.InteractionCreate, async (interaction) => {
	if (!interaction.isChatInputCommand())
		return;

	try {
		switch (interaction.commandName) {
			case "clear": {
				const count = channelMessages[interaction.channelId]?.length || 0;
				channelMessages[interaction.channelId] = null;

				await interaction.reply({
					content: `${emoji("acinfo")} ${count} chat context ở trong kênh này đã được loại bỏ!`
				});
				break;
			}

			case "alt": {
				const altChannels = config.get("altRoleChannels");
				const index = altChannels.indexOf(interaction.channelId);
				channelClient[interaction.channelId] = null;
				channelMessages[interaction.channelId] = null;

				if (index > -1) {
					altChannels.splice(index, 1);
					await interaction.reply({
						content: `${emoji("acinfo")} Kênh này hiện đang sử dụng ${code("SYSTEM_ROLE")}!`
					});
				} else {
					altChannels.push(interaction.channelId);
					await interaction.reply({
						content: `${emoji("acinfo")} Kênh này hiện đang sử dụng ${code("SYSTEM_ROLE_ALT")}!`
					});
				}

				config.save("altRoleChannels", altChannels);
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

client.on(Events.MessageCreate, async (message) => {
	if (message.author.bot)
		return;

	if (!message.content)
		return;

	if (message.content.startsWith("*clear")) {
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

	const displayName = (message.inGuild())
		? guild.members.cache.get(message.author.id).displayName
		: message.author.displayName;

	log.debug(`▼ Tin nhắn mới: \"${message.content}\" từ ${channelName} [${message.channelId}] bởi ${message.author.displayName} [${message.author.id}]`);
	const start = performance.now();

	try {
		// Pre-process the message content to make sure all placeholders are replaced.
		let messageContent = `${displayName} (@${message.author.globalName}) said: ${message.content}`;

		for (let [id, mention] of message.mentions.users) {
			let displayName = (message.inGuild())
				? guild.members.cache.get(mention.id).displayName
				: mention.displayName;

			messageContent = messageContent.replace(`<@${mention.id}>`, `[${displayName} (@${mention.globalName})]`);
		}

		for (let [id, mention] of message.mentions.roles)
			messageContent = messageContent.replace(`<@&${mention.id}>`, `[#${mention.name}]`);

		if (!channelClient[message.channelId]) {
			const altChannels = config.get("altRoleChannels");
			let systemMessage = (altChannels.includes(message.channelId))
				? SYSTEM_ROLE_ALT
				: SYSTEM_ROLE;

			systemMessage += lines(
				"",
				"Some format you will be expected to receive from messages as a discord bot:",
				" - Each message will begin by the author's information, with the following format: Name (@GlobalName) said:",
				" - User mention: [Name (@GlobalName)]",
				" - Role mention: [#RoleName]"
			);
			
			channelClient[message.channelId] = new ChatGPTAPI({
				apiKey: OPENAI_API_KEY,
				systemMessage: (altChannels.includes(message.channelId))
					? SYSTEM_ROLE_ALT
					: SYSTEM_ROLE,
				completionParams: {
					model: OPENAI_MODEL,
					temperature: 1,
					top_p: 1
				}
			});

			log.debug(`Đã tạo API client mới cho kênh ${channelName} (${message.channelId})`);
		}

		const api = channelClient[message.channelId];
		const maxLength = 1900;

		let updating = false;
		let updateImmediately = null;
		let completed = false;
		let currentLines = [];
		let currentLineStart = 0;
		let processingLine = 0;
		let codeblock = null;

		/** @type {Message} */
		let prevMessage = null;

		/** @type {Message} */
		let currentMessage = null;

		const thinking = THINKING_MESSAGE.replace("{@}", mention(message.author));
		const response = await message.reply({
			content: h2(`${emoji("loading", true)} ${bold(thinking)}`)
		});

		currentMessage = response;

		const updateMessage = async (/** @type {import("chatgpt").ChatMessage} */ chat) => {
			updating = true;
			const time = (performance.now() - start) / 1000;
			let statusBar = "";

			if (!completed)
				statusBar += `${emoji("loading", true)} `;

			if (chat.detail.usage) {
				const tokens = [chat.detail.usage.prompt_tokens, chat.detail.usage.completion_tokens];
				statusBar += code(`🕒 ${formatTime(time)}  🤖 ${chat.detail.model}  🧧 ${tokens.join("/")} (p/c)  🔮 ${channelMessages[message.channelId]?.length || 0} contexts`);
				statusBar = h3(statusBar);
			} else {
				statusBar += code(`🕒 ${formatTime(time)}  🤖 ${chat.detail.model}  🔮 ${channelMessages[message.channelId]?.length || 0} contexts`);
				statusBar = h2(statusBar);
			}

			let lines = chat.text.split("\n");

			for (let nth = processingLine; nth < lines.length; nth++) {
				const line = lines[nth];

				const cnth = nth - currentLineStart;
				currentLines[cnth] = line;

				if (line.startsWith("```")) {
					if (!codeblock) 
						codeblock = line;
					else
						codeblock = null;
				}

				if (currentLines.join("\n").length > maxLength) {
					// Buffer the last line.
					const lastLine = currentLines.pop();
					let currentContent = currentLines.join("\n");

					if (codeblock)
						currentContent += "\n```";

					await currentMessage.edit({ content: currentContent });
					prevMessage = currentMessage;
					currentMessage = null;

					// Time to reset our current lines to move to a new message!
					if (codeblock) {
						currentLineStart = nth - 1;
						currentLines = [codeblock, lastLine];
					} else {
						currentLineStart = nth;
						currentLines = [lastLine];
					}
				}

				processingLine = nth;
			}

			let content = [...currentLines];

			// Check if we have unclosing inline code.
			const acuteCount = (content[content.length - 1].match(/`/g) || []).length;
			if (!codeblock && acuteCount % 2 !== 0)
				content[content.length - 1] += "`";

			content = content.join("\n");

			if (codeblock) {
				// Add a fake codeblock end here to make sure format is not fcked up.
				content += "\n```";
			}

			content += `\n${statusBar}`;

			if (!currentMessage) {
				// Create a new follow up message.
				currentMessage = await prevMessage.reply({ content });
			} else {
				// Edit the message normally.
				await currentMessage.edit({ content });
			}

			if (updateImmediately) {
				updateMessage(updateImmediately);
				updateImmediately = null;
				return;
			}

			updating = false;
		}

		const onProgress = (/** @type {import("chatgpt").ChatMessage} */ partial) => {
			if (!partial.text)
				return;

			if (updating) {
				updateImmediately = partial;
				return;
			}

			updateMessage(partial);
		}

		if (!channelMessages[message.channelId]) {
			channelMessages[message.channelId] = [];

			const chat = await api.sendMessage(messageContent, {
				stream: true,
				onProgress
			});

			channelMessages[message.channelId].push(chat);
		} else {
			const chat = await api.sendMessage(messageContent, {
				parentMessageId: last(channelMessages[message.channelId]).id,
				stream: true,
				onProgress
			});

			channelMessages[message.channelId].push(chat);
		}

		completed = true;
		onProgress(last(channelMessages[message.channelId]));
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

await client.login(DISCORD_TOKEN);

const guild = await getGuild(GUILD_ID);
