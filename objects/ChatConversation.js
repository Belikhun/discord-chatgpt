import { ComponentType, DMChannel, Message, NewsChannel, StageChannel, TextChannel, VoiceChannel } from "discord.js";
import { ChatCompletion } from "./ChatCompletion.js";
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
	constructor(channel, model, instructions, mode) {
		this.channel = channel;
		this.model = model;
		this.mode = mode;
		// Resolve the bot's display name for this guild (nickname if set, otherwise username).
		const botName = (channel.guild)
			? (channel.guild.members.cache.get(discord.user.id)?.displayName || discord.user?.username || "")
			: (discord.user?.username || "");

		this.instructions = instructions.replaceAll("{@}", discord.user?.username || "");
		this.instructions = this.instructions.replaceAll("{NAME}", botName);
		this.log = scope(`conversation:${this.channel.id}`);

		/** @type {string[]} */
		this.conversationWakeupKeywords = [];
		this.skippedMessages = 0;
		this.chatActivated = false;

		this.instructions += "\n" + lines(
			"All messages come as structured JSON objects representing Discord messages.",
			"Interpret them as chat input — respond naturally in plain text following Discord conventions.",
			"",
			"Schema:",
			'{ "currentChannel": { "id": string, "name": string },',
			'  "messageAuthor": { "id": string, "username": string, "displayName": string },',
			'  "replyingTo"?: { "id": string, "username": string, "displayName": string },',
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
			Object.entries(ALL_EMOJIS)
				.map(([name, [id, animated]]) => (animated) ? `<a:${name}:${id}>` : `<:${name}:${id}>`)
				.join(" ")
		);

		/** @type {import("openai/resources/responses/responses.mjs").ResponseInput} */
		this.history = [];

		this.log.info(`New conversation created in ${this.mode} mode, using model ${this.model}`);
	}

	isReasoningModel() {
		return (this.model.match(/^o(\d{1})/gm) != null);
	}

	/**
	 * Handle incomming message.
	 * 
	 * @param	{Message<boolean>}	message
	 */
	async handle(message) {
		// Filter history that had been more than 1 day.
		this.history = this.history.filter(({ timestamp }) => ((Date.now() - timestamp) < 86400000));

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

		const shouldProcess = (this.chatActivated)
			|| (this.skippedMessages >= 4)
			|| message.mentions.users.has(discord.user.id)
			|| any(this.conversationWakeupKeywords, (keyword) => message.content.toLocaleLowerCase().includes(keyword.toLocaleLowerCase()))
			|| ((message.reference && message.reference.messageId) ? ((await message.channel.messages.fetch(message.reference.messageId)).author.id == discord.user.id) : false);

		if (!shouldProcess) {
			this.log.info(`Message added to history, will not process this message.`);
			this.skippedMessages += 1;
			return this;
		}

		this.skippedMessages = 0;
		const options = {};

		if (this.isReasoningModel()) {
			options.reasoning = {
				effort: "low",
				summary: "auto"
			};
		}

		const { output, output_text } = await openAI.responses.create({
			model: this.model,
			instructions: this.instructions,
			input: this.history.map((item) => {
				const i = { ...item }
				delete i.timestamp;
				return i;
			}),
			...options
		});

		this.log.info(`Got chat response: ${output_text}`);
		this.history.push(...output.map((item) => {
			item.timestamp = Date.now();
			return item;
		}));

		if (output_text.trim() !== "[skip]" && output_text.trim() !== "`[skip]`" && !output_text.startsWith("[skip]")) {
			this.chatActivated = true;

			await this.channel.send({
				content: output_text
			});
		} else {
			this.chatActivated = false;
		}

		return this;
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
			messageAuthor: { id: author.id, username: author.username, displayName: displayName },
			message: content
		};

		if (message.reference && message.reference.messageId) {
			const ref = await this.channel.messages.fetch(message.reference.messageId);
			data.replyingTo = {
				id: ref.author.id,
				username: ref.author.username,
				displayName: ref.author.displayName
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
