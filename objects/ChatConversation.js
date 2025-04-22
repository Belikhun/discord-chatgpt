import { DMChannel, Message, NewsChannel, StageChannel, TextChannel, VoiceChannel } from "discord.js";
import { ChatCompletion } from "./ChatCompletion.js";
import { lines } from "../format.js";

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
	 */
	constructor(channel, model, instructions) {
		this.channel = channel;
		this.model = model;
		this.instructions = instructions;

		this.instructions += lines(
			"All incoming messages will follow this strict format:",
			"  ${user.name} (${user.username}) <@${user.id}>:\\n${message}",
			"",
			"Additional elements you may encounter in messages:",
			" - User mentions will appear as: [${user.name} (${user.username}) <@${user.id}>]",
			" - Role mentions will appear as: [#${role.name} <@&${role.id}>]",
			"",
			"Important rules to follow:",
			" - When replying to or referring to a user, always use the format: <@${user.id}>.",
			" - When mentioning a role, always use the format: <@&${role.id}>.",
			"",
			"Interpretation Guidelines:",
			" - Treat tags like [Name (Username) <@id>] or [#Role <@&id>] as *references only* — do not attempt to interpret their meaning or generate extra context.",
			" - Do not guess or invent user names, roles, or identities that are not explicitly provided in the message content.",
			" - Stick strictly to the formats defined above. Do not introduce new formats or alter the structure.",
		);

		/** @type {import("openai/resources/responses/responses.mjs").ResponseInput} */
		this.history = [];
	}

	/**
	 * Handle incomming message.
	 * 
	 * @param	{Message<boolean>}	message
	 */
	async handle(message) {
		const chat = new ChatCompletion(this, message, this.model);
		await chat.start();
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
	processMessage(message) {
		const { author, content, mentions } = message;
		const displayName = author.displayName || author.username;

		// Start with sender format
		let messageContent = `${displayName} (${author.username}) <@${author.id}>:\n${content}`;

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
			const replacement = `[#${role.name} <@&${role.id}>]`;
			messageContent = messageContent.replace(mentionRegex, replacement);
		}

		return messageContent;
	}
}
