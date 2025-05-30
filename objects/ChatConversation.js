import { DMChannel, Message, NewsChannel, StageChannel, TextChannel, VoiceChannel } from "discord.js";
import { ChatCompletion } from "./ChatCompletion.js";
import { lines } from "../format.js";
import { scope } from "../logger.js";
import { openAI } from "../clients/openai.js";
import { discord } from "../clients/discord.js";
import { any } from "../utils.js";

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
		this.instructions = instructions.replaceAll("{@}", discord.user.username);
		this.log = scope(`conversation:${this.channel.id}`);

		/** @type {string[]} */
		this.conversationWakeupKeywords = [];
		this.skippedMessages = 0;

		this.instructions += lines(
			"",
			"The following instructions define the structure and format of incoming messages.",
			"Understanding this structure will help you accurately interpret user's message context.",
			"All variables are enclosed in curly brackets (e.g., {variable}).",
			"ONLY REPLY WITH YOUR MESSAGE, DO NOT APPLY THE FOLLOWING FORMAT TO YOUR RESPONSE MESSAGE!",
			"",
			"### Incoming Message Format:",
			"Channel: #{channel.name}",
			"User: {user.name} ({user.username}) <@{user.id}>",
			"(optional) Replying to: {reply.name} ({reply.username}) <@{reply.id}>",
			"Message content:",
			"{message}",
			"",
			"### Additional Elements You May Encounter:",
			" - User mentions: [{user.name} ({user.username}) <@{user.id}>]",
			" - Role mentions: [role {role.name} <@&{role.id}>]",
			"",
			"### Rules to Follow:",
			" - Always refer to users using the format: <@{user.id}>.",
			" - Always refer to roles using the format: <@&{role.id}>.",
			"",
			"### Interpretation Guidelines:",
			" - Treat all tags such as [Name (Username) <@id>] or [#Role <@&id>] as references only — do not infer meaning or context.",
			" - Do not guess, invent, or assume any names, roles, or identities not explicitly stated.",
			" - Follow the parsing formats above strictly. Do not create or use alternative formats.",
			" - Do not apply the incoming message format to your response message."
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
		if (this.mode === "assistant") {
			const chat = new ChatCompletion(this, message, this.model);
			await chat.start();

			return this;
		}

		const content = [];

		if (message.content.length > 0)
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
			content
		});

		const shouldProcess = (this.skippedMessages >= 4)
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
			input: this.history,
			...options
		});

		this.log.info(`Got chat response: ${output_text}`);
		this.history.push(...output);

		if (output_text.trim() !== "[skip]" && output_text.trim() !== "`[skip]`" && !output_text.startsWith("[skip]")) {
			await this.channel.send({
				content: output_text
			});
		}

		return this;
	}

	/**
	 * Pre-process a Discord message for chat completion.
	 *
	 * This formats the message with a standardized user label and replaces user/role mentions
	 * with explicit tags to help the AI better understand who is referenced.
	 *
	 * @param   {Message<boolean>}	message
	 * @returns {string}			Pre-processed message content
	 */
	async processMessage(message) {
		const { author, content, mentions } = message;
		const displayName = author.displayName || author.username;

		// Start with sender format
		let messageHeader = lines(
			`Channel: #${message.channel.name}`,
			`User: ${displayName} (${author.username}) <@${author.id}>`
		);

		if (message.reference && message.reference.messageId) {
			const ref = await this.channel.messages.fetch(message.reference.messageId);
			messageHeader += `\nReplying to: ${ref.author.displayName} (${ref.author.username}) <@${ref.author.id}>]`;
		}

		let messageContent = content;

		// Replace user mentions with expanded format
		for (let [id, user] of mentions.users) {
			const userDisplay = user.displayName || user.username;
			const mentionRegex = new RegExp(`<@!?${user.id}>`, 'g'); // cover both <@id> and <@!id>
			const replacement = `[${userDisplay} (${user.username}) <@${user.id}>]`;
			messageContent = messageContent.replace(mentionRegex, replacement);
		}

		// Replace role mentions with expanded format
		for (let [id, role] of mentions.roles) {
			const mentionRegex = new RegExp(`<@&${role.id}>`, 'g');
			const replacement = `[role ${role.name} <@&${role.id}>]`;
			messageContent = messageContent.replace(mentionRegex, replacement);
		}

		return lines(
			messageHeader,
			`Message content:`,
			messageContent
		);
	}
}
