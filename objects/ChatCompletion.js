import { DMChannel, Message } from "discord.js";
import { bold, code, emoji, formatTime, h3, lines, mention, sh, space, timestampMessage } from "../format.js";
import { openAI } from "../clients/openai.js";
import { scope } from "../logger.js";
import { ChatConversation } from "./ChatConversation.js";

import env from "../env.json" with { type: "json" };
const { THINKING_MESSAGE } = env;

const MESSAGE_MAX_LENGTH = 1900;
const INLINE_CODE_RE = /( \`|\` |^`[^`]|`,|`\.|\(`|`\)|[^`\n]`)/gm;
const CODE_BLOCK_RE = /```([a-zA-Z0-9]*)(?:$|\n|\s)/gm;

export class ChatCompletion {
	/**
	 * Create a new chat completion instance.
	 * 
	 * @param	{ChatConversation}									conversation
	 * @param	{Message<boolean>}									message
	 * @param	{import("openai/resources.mjs").ResponsesModel}		model
	 */
	constructor(conversation, message, model) {
		this.conversation = conversation;
		this.originalMessage = message;
		this.author = this.originalMessage.author;

		this.channelName = (message.channel instanceof DMChannel)
				? `${message.author.displayName}'s DM`
				: message.channel.name;

		this.log = scope(`chat:${message.id}`);

		this.model = model;

		/** @type {string} */
		this.reasoning = "";

		this.inResponse = false;
		this.hasUpdate = false;
		this.updating = false;

		/** @type {Message<boolean>} */
		this.currentResponse = null;

		this.isInCodeblock = false;
		this.codeblockHeader = null;
		this.isInCode = false;
		this.responseBuffer = "";

		/** @type {string[]} */
		this.responses = [];
		this.responseIndex = 0;
		this.sendNextMessage = false;

		this.completed = false;
	}

	get runtime() {
		return (performance.now() - this.startTime) / 1000;
	}

	thinkingMessage() {
		const thinking = THINKING_MESSAGE.replace("{@}", mention(this.author));

		const lines = [
			`### ${code(this.model, true)} ${space()}${emoji("minecraft_clock", true)} ${timestampMessage(this.startDate, "R")}`,
			`## ${emoji("loading", true)} ${bold(thinking)}`
		];

		if (this.reasoning.length > 0) {
			const words = this.reasoning.split(" ");
			let thought = "";

			if (words.length > 80) {
				thought = "..." + words.slice(-80)
					.join(" ");
			} else {
				thought = words.join(" ");
			}

			lines.push(sh(`> ${thought}`));
		}

		return lines.join("\n");
	}

	footer() {
		if (this.completed)
			return sh(`${emoji("resting", true)} ${code(this.model, true)} ${space()}${emoji("minecraft_clock", true)} ${formatTime(this.runtime)}`);

		return h3(`${emoji("loading", true)} ${code(this.model, true)} ${space()}${emoji("minecraft_clock", true)} ${timestampMessage(this.startDate, "R")}`);
	}

	isReasoningModel() {
		return (this.model.match(/^o(\d{1})/gm) != null);
	}

	async start() {
		this.startTime = performance.now();
		this.startDate = new Date();
		this.log.info(`Chat completion started`);
		this.originalMessage.channel.sendTyping();

		this.thinkingReply = await this.originalMessage.reply({
			content: this.thinkingMessage()
		});

		const content = [];

		if (this.originalMessage.content.length > 0)
			content.push({ type: "input_text", text: this.conversation.processMessage(this.originalMessage) });

		for (const attachment of this.originalMessage.attachments.values()) {
			if (attachment.contentType.startsWith("image")) {
				content.push({
					type: "input_image",
					image_url: attachment.url
				});

				continue;
			}
		}

		this.conversation.history.push({
			role: "user",
			content
		});

		const options = {};

		if (this.isReasoningModel()) {
			options.reasoning = {
				effort: "high",
				summary: "detailed"
			};
		}

		if (this.isReasoningModel() || ["gpt-4o", "gpt-4o-mini"].includes(this.model))
			options.tools = [ { type: "web_search_preview" } ];

		const response = await openAI.responses.create({
			model: this.model,
			instructions: this.conversation.instructions,
			input: this.conversation.history,
			stream: true,
			...options
		});

		for await (const event of response) {
			const { type } = event;

			this.log.debug(`Got chat completion event ${type}`);

			switch (type) {
				case "response.reasoning_summary_text.delta": {
					this.handleReasoning(event.delta);
					break;
				}

				case "response.reasoning_summary_part.added": {
					if (this.reasoning.length > 0)
						this.handleReasoning(" ");

					break;
				}

				case "response.output_text.delta": {
					this.handleOutput(event.delta);
					break;
				}

				case "response.output_text.done": {
					this.completed = true;
					this.deferUpdate();
					
					break;
				}

				case "response.output_text.done": {
					this.conversation.history.push({
						role: "assistant",
						content: event.text
					});

					break;
				}

				default:
					break;
			}
		}
	}

	/**
	 * Handle reasoning output
	 * 
	 * @param	{string}	delta
	 */
	handleReasoning(delta) {
		delta = delta
			.replaceAll("**", "")
			.replaceAll("*", "")
			.replaceAll(/\`\`\`(.*)\n/gm, " ")
			.replaceAll("```", "")
			.replaceAll("`", "")
			.replaceAll("\n\n", " ")
			.replaceAll("\n", " ");

		this.reasoning += delta;
		this.deferUpdate();
	}

	/**
	 * Handle response output
	 * 
	 * @param	{string}	delta
	 */
	handleOutput(delta) {
		if (!this.inResponse) {
			// Re-use thinking reply message.
			this.currentResponse = this.thinkingReply;
			this.thinkingReply = null;
			this.inResponse = true;
		}

		// // Check for codeblock
		// const codeblockMatch = delta.match(CODE_BLOCK_RE);
		// if (codeblockMatch && codeblockMatch[0]) {
		// 	if (!this.isInCodeblock) {
		// 		// We just got into a codeblock, raise the flag and store the codeblock
		// 		// start line.
		// 		this.codeblockHeader = codeblockMatch[0];
		// 		this.isInCodeblock = true;
		// 	} else {
		// 		this.isInCodeblock = false;
		// 		this.codeblockHeader = null;
		// 	}
		// }

		// if (!this.isInCodeblock) {
		// 	// Check for inline code
		// 	const ticks = (delta.match(INLINE_CODE_RE) || []).length;
		// 	if (ticks % 2 == 1) {
		// 		// Odd number of ticks, flip the inCode flag.
		// 		this.isInCode = !this.isInCode;
		// 	}
		// }

		const newResponse = this.responseBuffer + delta;

		if (newResponse.length > MESSAGE_MAX_LENGTH) {
			const split = this.breakAndFixMessage(newResponse, MESSAGE_MAX_LENGTH);
			this.responses[this.responseIndex] = split.splitted;

			this.responseBuffer = split.leftover;
			this.isInCode = split.leftoverInfo.isInCode;
			this.isInCodeblock = split.leftoverInfo.isInCodeblock;
			this.codeblockHeader = split.leftoverInfo.codeblockHeader;
			this.sendNextMessage = true;
		} else {
			const state = this.checkClosingBlocks(newResponse);
			this.responseBuffer = newResponse;
			this.isInCode = state.isInCode;
			this.isInCodeblock = state.isInCodeblock;
			this.codeblockHeader = state.codeblockHeader;
		}

		this.deferUpdate();
	}

	/**
	 * Break input message to neatly fit into specified maxLength, and close
	 * leftover codes and codeblocks if broken in mid of message.
	 * 
	 * @param	{string}	message
	 * @param	{number}	maxLength
	 */
	breakAndFixMessage(message, maxLength) {
		let [splitted, leftover] = this.breakMessage(message, maxLength);
		const splittedInfo = this.checkClosingBlocks(splitted);

		if (splittedInfo.isInCodeblock) {
			// Close opening codeblock and copy header to leftover.
			splitted += `\n\`\`\``;
			leftover = `${splittedInfo.codeblockHeader}\n${leftover}`;
		} else if (splittedInfo.isInCode) {
			splitted += `\``;
			leftover = `\`${leftover}`;
		}

		const leftoverInfo = this.checkClosingBlocks(leftover);
		return { splitted, leftover, leftoverInfo };
	}

	/**
	 * Check closing block status.
	 * 
	 * @param	{string}	content
	 * @returns	{{ isInCode: boolean, isInCodeblock: boolean, codeblockHeader: ?string }}
	 */
	checkClosingBlocks(content) {
		let isInCode = false;
		let isInCodeblock = false;
		let codeblockHeader = null;

		// Check for codeblock
		const codeblockMatch = content.match(/```([a-zA-Z0-9]*)(?:$|\n)/gm);

		if (codeblockMatch && codeblockMatch.length % 2 == 1) {
			isInCodeblock = true;
			codeblockHeader = codeblockMatch[codeblockMatch.length - 1];
		} else {
			// Check for inline code
			const ticks = (content.match(INLINE_CODE_RE) || []).length;

			// Odd number of ticks, we are ending inside inline code.
			isInCode = (ticks % 2 == 1);
		}

		return { isInCode, isInCodeblock, codeblockHeader };
	}

	/**
	 * Break input message to neatly fit into specified maxLength
	 * 
	 * @param	{string}	message
	 * @param	{number}	maxLength
	 * @returns	{string[]}
	 */
	breakMessage(message, maxLength) {
		//* PLAN 1
		//* Backtrace to first line-break occurrence
		let cursor = message.length;

		while (true) {
			const index = message.lastIndexOf("\n", cursor - 1);

			if (index < 0) {
				// No line-break left. We will fallback to 2nd method.
				break;
			}

			if (index + 1 < maxLength) {
				// We can safely break message from this point.
				return [
					message.slice(0, index).trim(),
					message.slice(index, message.length).trim()
				];
			}

			cursor = index;
		}

		//* PLAN 2
		//* Culmulative sentences until reaches limit
		const sentences = message.split(". ");
		let output = "";

		for (const [index, sentence] of sentences.entries()) {
			let current = (output.length > 0)
				? `${output}. ${sentence}`
				: sentence;

			if (current.length > maxLength) {
				// Passed desired length, use current output.
				return [
					`${output}.`,
					sentences.slice(index, sentences.length).join(". ")
				];
			}

			output = current;
		}

		//* PLAN 3
		//* Hard split at max langth
		return [
			message.slice(0, maxLength - 1).trim(),
			message.slice(maxLength - 1, message.length).trim()
		];
	}

	deferUpdate() {
		this.hasUpdate = true;

		if (!this.updating)
			this.update();

		return this;
	}

	async update() {
		this.hasUpdate = false;
		this.updating = true;
		this.log.info(`Pushing update to discord...`);

		if (!this.inResponse) {
			await this.thinkingReply.edit({
				content: this.thinkingMessage()
			});
		} else {
			if (this.sendNextMessage) {
				this.currentResponse.edit({
					content: this.responses[this.responseIndex]
				});

				this.responseIndex += 1;
				this.currentResponse = null;
				this.sendNextMessage = false;
			}

			let content = this.responseBuffer;
			// console.log(this.responseBuffer);
			// console.log(this.isInCodeblock, this.isInCode);

			if (this.isInCodeblock) {
				// Close opening codeblock.
				content += `\n\`\`\``;
			} else if (this.isInCode) {
				content += `\``;
			}

			if (!this.currentResponse) {
				this.currentResponse = await this.originalMessage.channel.send({
					content: lines(
						content,
						"",
						this.footer()
					)
				});
			} else {
				await this.currentResponse.edit({
					content: lines(
						content,
						"",
						this.footer()
					)
				});
			}
		}

		this.log.success(`Update pushed to discord`);
		
		if (this.hasUpdate) {
			// Re-update again if we have a new update to push to discord.
			this.log.info(`Have new update, preparing to push again...`);
			this.update();
		} else {
			this.updating = false;
		}
	}
}
