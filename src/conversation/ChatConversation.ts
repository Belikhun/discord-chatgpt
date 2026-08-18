import { ComponentType, DMChannel } from "discord.js";
import { scope, type Logger } from "../logger";
import { lines } from "../format";
import { ALL_EMOJIS } from "../emojis";
import { any } from "../utils";
import { discord } from "../discord/client";
import { getProviderForModel } from "../ai/registry";
import { ModelTrait } from "../ai/types";
import type { ChatMessage, ConversationItem, HistoryEntry, MessagePart, ReasoningConfig, ToolDefinition } from "../ai/types";
import { getToolDefinitions, runToolCalls, buildDeveloperMessages } from "../tools/registry";
import type { ToolContext } from "../tools/types";
import { ChatCompletion } from "./ChatCompletion";
import { processOutputEmojis, getReusableCustomEmojiMentions } from "./emojiProcessing";
import type { ConversationChannel, ConversationMode, IncomingMessage } from "./types";

export interface ResponseRequest {
	context: ToolContext;
	input: ConversationItem[];
	tools: ToolDefinition[];
}

export class ChatConversation {
	channel: ConversationChannel;
	model: string;
	mode: ConversationMode;
	nickname: string;
	reasoningEffort: string;
	lastMessage: IncomingMessage | null;
	instructions: string;
	log: Logger;

	conversationWakeupKeywords: string[];
	skippedMessages: number;
	skipStreak: number;
	chatActivated: boolean;
	pendingProcess: boolean;
	processing: boolean;
	forceRespondOnNextProcess: boolean;

	history: HistoryEntry[];

	/**
	 * Create a new chat conversation.
	 */
	constructor(channel: ConversationChannel, model: string, instructions: string, mode: ConversationMode, {
		nickname = "ChatGPT",
		reasoningEffort = "medium"
	}: { nickname?: string; reasoningEffort?: string } = {}) {
		this.channel = channel;
		this.model = model;
		this.mode = mode;
		this.nickname = nickname;
		this.reasoningEffort = reasoningEffort;
		this.lastMessage = null;

		// Resolve the bot's display name for this guild (nickname if set, otherwise username).
		const botName = (channel.guild)
			? (channel.guild.members.cache.get(discord.user!.id)?.displayName || discord.user?.username || "")
			: (discord.user?.username || "");

		this.instructions = instructions.replaceAll("{@}", discord.user?.username || "");
		this.instructions = this.instructions.replaceAll("{NAME}", botName);
		this.instructions = this.instructions.replaceAll("{NICK}", this.nickname);
		this.log = scope(`conversation:${this.channel.id}`);

		this.conversationWakeupKeywords = [];
		this.skippedMessages = 0;
		this.skipStreak = 0;
		this.chatActivated = false;
		this.pendingProcess = false;
		this.processing = false;
		this.forceRespondOnNextProcess = false;

		this.instructions += "\n" + lines(
			"All messages come as structured JSON objects representing Discord messages.",
			"Interpret them as chat input — respond naturally in plain text following Discord conventions.",
			"Use available tools when you need more surrounding context (recent messages, server info, emojis, or memory), or to read webpage content when a message references a URL (fetch_webpage returns the page as markdown).",
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
			" - Emojis: use :emoji_name: or Unicode emoji only for your own emoji usage. Do not invent or emit full Discord custom emoji codes for available emojis; they will be resolved after generation.",
			" - If you directly copy or reuse a full custom emoji from another user's message, preserve that exact full Discord format as written (<:name:id> or <a:name:id>).",
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

		this.history = [];

		this.log.info(`New conversation created in ${this.mode} mode, using model ${this.model}`);
	}

	get provider() {
		return getProviderForModel(this.model);
	}

	buildRuntimeContext(message: IncomingMessage | null = this.lastMessage, { forceRespond = false }: { forceRespond?: boolean } = {}): ToolContext {
		return message
			? { conversation: this, message, forceRespond }
			: { conversation: this, forceRespond };
	}

	async buildResponseRequest(message: IncomingMessage | null = this.lastMessage, { forceRespond = false }: { forceRespond?: boolean } = {}): Promise<ResponseRequest> {
		const context = this.buildRuntimeContext(message, { forceRespond });
		const developerMessages: ConversationItem[] = await buildDeveloperMessages(context);
		let input: ConversationItem[] = this.history.map((entry) => entry.item);

		if (forceRespond) {
			developerMessages.unshift({
				kind: "message",
				role: "developer",
				content: [{
					type: "text",
					text: "Tin nhắn mới nhất đã mention trực tiếp bạn bằng @. Bạn phải trả lời trực tiếp tin nhắn đó và không được trả về [skip]. Hãy trả lời theo ngôn ngữ của tin nhắn gần nhất: tiếng Việt nếu người dùng dùng tiếng Việt, tiếng Anh nếu người dùng dùng tiếng Anh, và chỉ trộn ngôn ngữ khi ngữ cảnh thật sự tự nhiên."
				}]
			});
		}

		if (developerMessages.length > 0)
			input = developerMessages.concat(input);

		return {
			context,
			input,
			tools: await getToolDefinitions(context)
		};
	}

	purgeExpiredHistory(): void {
		this.history = this.history.filter(({ timestamp }) => ((Date.now() - timestamp) < 86400000));
	}

	isReasoningModel(): boolean {
		return this.provider.hasTrait(this.model, ModelTrait.Thinking);
	}

	getReasoningOptions(): ReasoningConfig | null {
		if (!this.isReasoningModel())
			return null;

		return {
			effort: (this.reasoningEffort || "medium") as ReasoningConfig["effort"],
			summary: "auto"
		};
	}

	pushHistory(...items: ConversationItem[]): void {
		const timestamp = Date.now();
		this.history.push(...items.map((item) => ({ item, timestamp })));
	}

	/**
	 * Handle incomming message.
	 */
	async handle(message: IncomingMessage): Promise<this> {
		this.purgeExpiredHistory();
		this.log.info(`Handling message ${message.id} in channel ${message.channel.id}.`);

		if (this.mode === "assistant") {
			const chat = new ChatCompletion(this, message, this.model);
			await chat.start();

			return this;
		}

		const content: MessagePart[] = [];

		if (message.content.length > 0 || message.components.length > 0)
			content.push({ type: "text", text: await this.processMessage(message) });

		for (const attachment of message.attachments.values()) {
			if (attachment.contentType?.startsWith("image")) {
				content.push({
					type: "image",
					url: attachment.url
				});

				continue;
			}
		}

		// Empty message, we prob don't want to process this.
		if (content.length == 0)
			return this;

		this.lastMessage = message;

		this.pushHistory({
			kind: "message",
			role: "user",
			content
		});

		const wakeupKeywordMatched = any(
			this.conversationWakeupKeywords,
			(keyword) => message.content.toLocaleLowerCase().includes(keyword.toLocaleLowerCase())
		);
		const botMentioned = message.mentions.users.has(discord.user!.id);

		const skipThreshold = (this.skipStreak <= 1) ? 1 : 4;
		const shouldProcess = (this.chatActivated)
			|| (this.skippedMessages >= skipThreshold)
			|| botMentioned
			|| wakeupKeywordMatched
			|| ((message.reference && message.reference.messageId) ? ((await message.channel.messages.fetch(message.reference.messageId)).author.id == discord.user!.id) : false);

		if (!shouldProcess) {
			this.log.info(`Message ${message.id} added to history, skipping processing.`);
			this.skippedMessages += 1;
			this.scheduleProcess();
			return this;
		}

		this.skippedMessages = 0;
		this.pendingProcess = true;
		if (botMentioned || wakeupKeywordMatched) {
			if (message.channel?.sendTyping) {
				message.channel.sendTyping().catch((err: any) => {
					this.log.warn(`Failed to send typing indicator for mention/wakeup trigger: ${err.message}`);
				});
			}
		}

		if (botMentioned) {
			this.forceRespondOnNextProcess = true;
		}

		this.log.info(`Message ${message.id} queued for processing.`);
		this.scheduleProcess();

		return this;
	}

	scheduleProcess(): void {
		if (!this.pendingProcess)
			return;

		if (this.processing) {
			this.log.info(`Processing in progress, waiting to handle queued messages.`);
			return;
		}

		this.pendingProcess = false;
		this.log.info(`Processing queued messages in channel ${this.channel.id}.`);
		this.respondFromHistory().catch((err) => {
			this.log.error(`Failed to process queued messages: ${err.message}`);
		});
	}

	async handleStructuredPrompt(payload: string | Record<string, any>, { activateChat = true, role = "user" }: { activateChat?: boolean; role?: ChatMessage["role"] } = {}): Promise<this> {
		this.purgeExpiredHistory();
		this.lastMessage = null;

		const text = (typeof payload === "string")
			? payload
			: JSON.stringify(payload);

		this.pushHistory({
			kind: "message",
			role,
			content: [{ type: "text", text }]
		});

		if (activateChat) {
			this.chatActivated = true;
			this.skippedMessages = 0;
		}

		await this.respondFromHistory({ activateChat });
		return this;
	}

	async respondFromHistory({ activateChat = true }: { activateChat?: boolean } = {}): Promise<string | null> {
		if (this.processing) {
			this.pendingProcess = true;
			this.log.info(`Already processing, will handle pending messages after completion.`);
			return null;
		}

		this.processing = true;
		this.pendingProcess = false;
		this.log.info(`Start processing response for channel ${this.channel.id}.`);
		const forceRespond = this.forceRespondOnNextProcess;
		this.forceRespondOnNextProcess = false;
		const request = await this.buildResponseRequest(this.lastMessage, { forceRespond });
		const context = request.context;
		const provider = this.provider;
		let input = request.input;

		let output_text = "";
		let pass = 0;

		while (pass < 3) {
			const response = await provider.respond({
				model: this.model,
				instructions: this.instructions,
				input,
				tools: request.tools,
				reasoningEffort: this.getReasoningOptions()?.effort ?? null
			});

			this.pushHistory(...response.items);

			if (response.toolCalls.length === 0) {
				output_text = response.outputText;
				break;
			}

			const toolOutputs = await runToolCalls(response.toolCalls, context);
			this.pushHistory(...toolOutputs);

			input = input.concat(response.items, toolOutputs);
			pass += 1;
		}

		this.log.info(`Got chat response: ${output_text}`);

		const trimmed = output_text.trim();

		if (trimmed.length === 0 || !trimmed || trimmed === "[skip]" || trimmed === "`[skip]`" || trimmed.startsWith("[skip]")) {
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

			const perms = this.channel.permissionsFor?.(discord.user);
			return perms?.has("SendMessages") ?? false;
		};

		if (!canSend()) {
			this.log.warn(`Missing SendMessages permission for channel ${this.channel.id}, skipping send.`);
			this.processing = false;
			if (this.pendingProcess)
				this.scheduleProcess();
			return null;
		}

		output_text = this.processOutputEmojis(output_text);

		try {
			await this.channel.send!({
				content: output_text
			});
		} catch (err: any) {
			this.log.error(`Failed to send message to channel ${this.channel.id}: ${err.message}`);
			this.processing = false;
			if (this.pendingProcess)
				this.scheduleProcess();
			return null;
		}

		this.processing = false;
		this.log.info(`Response sent to channel ${this.channel.id}.`);
		if (this.pendingProcess)
			this.scheduleProcess();

		return output_text;
	}

	processOutputEmojis(text: string): string {
		return processOutputEmojis(text, this.getReusableCustomEmojiMentions(), this.log);
	}

	getReusableCustomEmojiMentions(): Set<string> {
		return getReusableCustomEmojiMentions(this.history);
	}

	resolveDisplayName(user: any, member: any = null): string {
		return member?.displayName || user?.displayName || user?.username || "";
	}

	/**
	 * Pre-process a Discord message for chat completion.
	 *
	 * This formats the message with a standardized user label and replaces user/role mentions
	 * with explicit tags to help the AI better understand who is referenced.
	 */
	async processMessage(message: IncomingMessage): Promise<string> {
		let { author, content, mentions } = message;
		const displayName = this.resolveDisplayName(author, message.member);

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

		const data: Record<string, any> = {
			currentChannel: { id: message.channel.id, name: message.channel.name },
			channelId: message.channel.id,
			serverId: message.guild?.id || null,
			messageId: message.id,
			messageAuthor: { id: author.id, username: author.username, displayName: displayName },
			message: content
		};

		if (message.reference && message.reference.messageId) {
			const ref = await this.channel.messages!.fetch(message.reference.messageId);
			data.replyingTo = {
				id: ref.author.id,
				username: ref.author.username,
				displayName: this.resolveDisplayName(ref.author, ref.member),
				messageId: ref.id
			};
		}

		// Replace user mentions with expanded format
		for (let [id, user] of mentions.users) {
			const userDisplay = this.resolveDisplayName(user, mentions.members?.get(id));
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
