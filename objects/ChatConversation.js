import { ComponentType, DMChannel, Message, NewsChannel, StageChannel, TextChannel, VoiceChannel } from "discord.js";
import { ChatCompletion } from "./ChatCompletion.js";
import { ChatTool } from "./ChatTool.js";
import { lines } from "../format.js";
import { scope } from "../logger.js";
import { openAI } from "../clients/openai.js";
import { discord } from "../clients/discord.js";
import { ALL_EMOJIS, any } from "../utils.js";

/**
 * @typedef {DMChannel | NewsChannel | StageChannel | TextChannel | VoiceChannel} ConversationChannel
 */

export class ChatConversation {
	/**
	 * Create a new chat conversation.
	 * 
	 * @param	{ConversationChannel}								channel
	 * @param	{import("openai/resources.mjs").ResponsesModel}		model
	 * @param	{string}											instructions
	 * @param	{"chat" | "assistant"}								mode
	 */
	constructor(channel, model, instructions, mode, {
		nickname = "ChatGPT"
	} = {}) {
		this.channel = channel;
		this.model = model;
		this.mode = mode;
		this.nickname = nickname;

		// Resolve the bot's display name for this guild (nickname if set, otherwise username).
		const botName = (channel.guild)
			? (channel.guild.members.cache.get(discord.user.id)?.displayName || discord.user?.username || "")
			: (discord.user?.username || "");

		this.instructions = instructions.replaceAll("{@}", discord.user?.username || "");
		this.instructions = this.instructions.replaceAll("{NAME}", botName);
		this.instructions = this.instructions.replaceAll("{NICK}", this.nickname);
		this.log = scope(`conversation:${this.channel.id}`);

		/** @type {string[]} */
		this.conversationWakeupKeywords = [];
		this.skippedMessages = 0;
		this.skipStreak = 0;
		this.chatActivated = false;
		this.pendingProcess = false;
		this.processing = false;
		this.processTimer = null;
		this.processDebounceMs = 1000;

		this.instructions += "\n" + lines(
			"All messages come as structured JSON objects representing Discord messages.",
			"Interpret them as chat input — respond naturally in plain text following Discord conventions.",
			"",
			"Schema:",
			'{ "currentChannel": { "id": string, "name": string },',
			'  "channelId": string,',
			'  "serverId": string,',
			'  "messageId": string,',
			'  "messageAuthor": { "id": string, "username": string, "displayName": string },',
			'  "replyingTo"?: { "id": string, "username": string, "displayName": string, "messageId": string },',
			'  "message": string }',
			"",
			"Discord formatting rules:",
			" - User mention: <@{user.id}>",
			" - Role mention: <@&{role.id}>",
			" - Channel mention: <#{channel.id}>",
			" - Markdown: *italic*, **bold**, `code`, ```blocks```",
			" - Timestamps: <t:unix[:style]>",
			" - Emojis: :emoji_name: or Unicode emoji",
			"",
			"Rules:",
			" - Reply in plain text only — no JSON or structural output.",
			" - Never echo or restate the input JSON.",
			" - Use only IDs provided; don't invent users, roles, or channels.",
			" - The `message` field is the user's actual text; `replyingTo` gives reply context.",
			"",
			"The following custom emojis are available for use in responses (each separated by whitespace):",
			"```",
			Object.entries(ALL_EMOJIS)
				.map(([name]) => `:${name}:`)
				.join(" "),
			"```"
		);

		/** @type {import("openai/resources/responses/responses.mjs").ResponseInput} */
		this.history = [];

		this.log.info(`New conversation created in ${this.mode} mode, using model ${this.model}`);
	}

	purgeExpiredHistory() {
		this.history = this.history.filter(({ timestamp }) => ((Date.now() - timestamp) < 86400000));
	}

	isReasoningModel() {
		return (/^o\d/.test(this.model) || /^gpt-5(\.|$)/.test(this.model));
	}

	/**
	 * Handle incomming message.
	 * 
	 * @param	{Message<boolean>}	message
	 */
	async handle(message) {
		this.purgeExpiredHistory();

		if (this.mode === "assistant") {
			const chat = new ChatCompletion(this, message, this.model);
			await chat.start();

			return this;
		}

		const content = [];

		if (message.content.length > 0 || message.components.length > 0)
			content.push({ type: "input_text", text: await this.processMessage(message) });

		for (const attachment of message.attachments.values()) {
			if (attachment.contentType.startsWith("image")) {
				content.push({
					type: "input_image",
					image_url: attachment.url
				});

				continue;
			}
		}

		// Empty message, we prob don't want to process this.
		if (content.length == 0)
			return this;

		this.history.push({
			role: "user",
			content,
			timestamp: Date.now()
		});

		const skipThreshold = (this.skipStreak <= 1) ? 1 : 4;
		const shouldProcess = (this.chatActivated)
			|| (this.skippedMessages >= skipThreshold)
			|| message.mentions.users.has(discord.user.id)
			|| any(this.conversationWakeupKeywords, (keyword) => message.content.toLocaleLowerCase().includes(keyword.toLocaleLowerCase()))
			|| ((message.reference && message.reference.messageId) ? ((await message.channel.messages.fetch(message.reference.messageId)).author.id == discord.user.id) : false);

		if (!shouldProcess) {
			this.log.info(`Message added to history, will not process this message.`);
			this.skippedMessages += 1;
			this.scheduleProcess();
			return this;
		}

		this.skippedMessages = 0;
		this.pendingProcess = true;
		this.scheduleProcess();

		return this;
	}

	scheduleProcess() {
		if (this.processTimer) {
			clearTimeout(this.processTimer);
		}

		this.processTimer = setTimeout(async () => {
			this.processTimer = null;

			if (!this.pendingProcess) {
				return;
			}

			if (this.processing) {
				this.scheduleProcess();
				return;
			}

			try {
				await this.respondFromHistory();
			} catch (err) {
				this.log.error(`Failed to process debounced messages: ${err.message}`);
			} finally {
				this.pendingProcess = false;
			}
		}, this.processDebounceMs);
	}

	async handleStructuredPrompt(payload, { activateChat = true, role = "user" } = {}) {
		this.purgeExpiredHistory();

		const text = (typeof payload === "string")
			? payload
			: JSON.stringify(payload);

		this.history.push({
			role,
			content: [{ type: "input_text", text }],
			timestamp: Date.now()
		});

		if (activateChat) {
			this.chatActivated = true;
			this.skippedMessages = 0;
		}

		await this.respondFromHistory({ activateChat });
		return this;
	}

	async respondFromHistory({ activateChat = true } = {}) {
		if (this.processing) {
			this.pendingProcess = true;
			return null;
		}

		this.processing = true;
		const options = { tools: ChatTool.tools() };

		let input = this.history.map((item) => {
			const i = { ...item };
			delete i.timestamp;
			return i;
		});

		let response = null;
		let output = [];
		let output_text = "";
		let toolCalls = [];
		let pass = 0;

		while (pass < 3) {
			response = await openAI.responses.create({
				model: this.model,
				instructions: this.instructions,
				input,
				...options
			});

			output = response.output || [];
			this.history.push(...output.map((item) => ({
				...item,
				timestamp: Date.now()
			})));

			toolCalls = ChatTool.extractToolCalls(output);
			if (toolCalls.length === 0) {
				output_text = response.output_text || this.extractOutputText(output);
				break;
			}

			const toolOutputs = await ChatTool.runToolCalls(toolCalls, { conversation: this });
			this.history.push(...toolOutputs.map((item) => ({
				...item,
				timestamp: Date.now()
			})));

			const sanitizedOutput = output.map((item) => {
				const cloned = { ...item };
				delete cloned.timestamp;
				return cloned;
			});
			const sanitizedToolOutputs = toolOutputs.map((item) => {
				const cloned = { ...item };
				delete cloned.timestamp;
				return cloned;
			});
			input = input.concat(sanitizedOutput, sanitizedToolOutputs);
			pass += 1;
		}

		this.log.info(`Got chat response: ${output_text}`);

		const trimmed = output_text.trim();

		if (trimmed === "[skip]" || trimmed === "`[skip]`" || trimmed.startsWith("[skip]")) {
			this.chatActivated = false;
			this.skipStreak += 1;
			this.log.info(`Response was [skip], not sending message.`);
			this.processing = false;
			if (this.pendingProcess)
				this.scheduleProcess();
			return null;
		}

		if (activateChat)
			this.chatActivated = true;

		this.skipStreak = 0;

		const canSend = () => {
			if (this.channel instanceof DMChannel)
				return true;

			const perms = this.channel.permissionsFor(discord.user);
			return perms?.has("SendMessages") ?? false;
		};

		if (!canSend()) {
			this.log.warn(`Missing SendMessages permission for channel ${this.channel.id}, skipping send.`);
			this.processing = false;
			if (this.pendingProcess)
				this.scheduleProcess();
			return null;
		}

		// Replace emojis with actual Discord emoji syntax.
		output_text = output_text.replaceAll(/:([a-zA-Z0-9_]+):/g, (match, p1) => {
			const emojiData = ALL_EMOJIS[p1];
			if (emojiData) {
				const [emojiId, animated] = emojiData;
				return `<${animated ? "a" : ""}:${p1}:${emojiId}>`;
			}

			return match;
		});

		try {
			await this.channel.send({
				content: output_text
			});
		} catch (err) {
			this.log.error(`Failed to send message to channel ${this.channel.id}: ${err.message}`);
			this.processing = false;
			if (this.pendingProcess)
				this.scheduleProcess();
			return null;
		}

		this.processing = false;
		if (this.pendingProcess)
			this.scheduleProcess();

		return output_text;
	}

	extractOutputText(output = []) {
		const texts = [];

		for (const item of output) {
			if (item?.type !== "message")
				continue;

			for (const part of item.content || []) {
				if (part?.type === "output_text" && typeof part.text === "string")
					texts.push(part.text);
			}
		}

		return texts.join("\n");
	}

	/**
	 * Pre-process a Discord message for chat completion.
	 *
	 * This formats the message with a standardized user label and replaces user/role mentions
	 * with explicit tags to help the AI better understand who is referenced.
	 *
	 * @param   {Message<boolean>}		message
	 * @returns {Promise<string>}		Pre-processed message content
	 */
	async processMessage(message) {
		let { author, content, mentions } = message;
		const displayName = author.displayName || author.username;

		if (message.components.length > 0) {
			for (const component of message.components) {
				switch (component.type) {
					case ComponentType.TextDisplay:
						content += `\n${component.content}`;
						break;

					default:
						break;
				}
			}
		}

		const data = {
			currentChannel: { id: message.channel.id, name: message.channel.name },
			channelId: message.channel.id,
			serverId: message.guild?.id || null,
			messageId: message.id,
			messageAuthor: { id: author.id, username: author.username, displayName: displayName },
			message: content
		};

		if (message.reference && message.reference.messageId) {
			const ref = await this.channel.messages.fetch(message.reference.messageId);
			data.replyingTo = {
				id: ref.author.id,
				username: ref.author.username,
				displayName: ref.author.displayName,
				messageId: ref.id
			};
		}

		// Replace user mentions with expanded format
		for (let [id, user] of mentions.users) {
			const userDisplay = user.displayName || user.username;
			const mentionRegex = new RegExp(`<@!?${user.id}>`, 'g'); // cover both <@id> and <@!id>
			const replacement = `[${userDisplay} (${user.username}) <@${user.id}>]`;
			data.message = data.message.replace(mentionRegex, replacement);
		}

		// Replace role mentions with expanded format
		for (let [id, role] of mentions.roles) {
			const mentionRegex = new RegExp(`<@&${role.id}>`, 'g');
			const replacement = `[role ${role.name} <@&${role.id}>]`;
			data.message = data.message.replace(mentionRegex, replacement);
		}

		return JSON.stringify(data);
	}
}
