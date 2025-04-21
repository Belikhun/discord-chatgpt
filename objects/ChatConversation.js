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
			"",
			"Formats you will receive in messages as a discord bot:",
			" - Message author: ${user.name} (${user.username}) <@${user.id}>:\\n${message}",
			" - User mention: [${user.name} (${user.username}) <@${user.id}>]",
			" - Role mention: [#${role.name} <@&${role.id}>]",
			"When you want to reply or mention an user, use their user id following discord mention format (example: <@userid>).",
			"When you want to mention a role, use their role id following discord role format (example: <@&roleid>).",
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
	 * Pre-process message for chat completion.
	 * 
	 * @param 	{Message<boolean>}	message 
	 */
	processMessage(message) {
		const displayName = message.author.displayName;
		let messageContent = `${displayName} (${message.author.username}) <@${message.author.id}>:\n${message.content}`;

		for (let [id, mention] of message.mentions.users) {
			const displayName = mention.displayName;
			messageContent = messageContent.replace(`<@${mention.id}>`, `[${displayName} (${mention.username}) <@${mention.id}>]`);
		}

		for (let [id, mention] of message.mentions.roles)
			messageContent = messageContent.replace(`<@&${mention.id}>`, `[#${mention.name} <@&${mention.id}>]`);

		return messageContent;
	}
}
