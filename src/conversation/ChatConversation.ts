import { ComponentType, DMChannel } from "discord.js";
import { scope, type Logger } from "../logger";
import { lines } from "../format";
import { any } from "../utils";
import { discord } from "../discord/client";
import { getProviderForModel } from "../ai/registry";
import { ModelTrait } from "../ai/types";
import type { ChatMessage, ConversationItem, HistoryEntry, MessagePart, ReasoningConfig, ToolDefinition } from "../ai/types";
import { getToolDefinitions, buildDeveloperMessages } from "../tools/registry";
import { appendHistory, compactHistory, loadHistory } from "../stores/history";
import { buildContextMessages } from "./contextSources";
import { estimateTokens, historyBudget, prepareHistory, startsTurn, transcript } from "./context";
import type { ToolContext } from "../tools/types";
import { ChatCompletion } from "./ChatCompletion";
import { runToolLoop } from "./toolLoop";
import { processOutputEmojis, getReusableCustomEmojiMentions } from "./emojiProcessing";
import { splitMessage } from "./messageSplitter";
import type { ConversationChannel, ConversationMode, IncomingMessage } from "./types";

const SUMMARY_INSTRUCTIONS = "You maintain the running summary of a Discord conversation. Merge the new conversation into the summary so far. Keep who said what, decisions, open questions, facts people shared about themselves, and anything the assistant promised to do. Drop greetings and small talk. Write in the conversation's language, at most 250 words, plain prose or short bullets, no IDs except user mentions.";

/**
 * Asks the model to say it is on it before a long job, so nobody wonders
 * whether they were heard: chat lines in Minecraft cannot be edited, and a
 * chat-mode Discord reply only lands when the whole answer is done.
 */
const ACKNOWLEDGE_RULE = lines(
	"Acknowledging long work:",
	" - When answering needs tools (looking things up, searching the web, reading pages or server data), write one short sentence in the user's language saying you are on it, in the same response as your first tool call. It is sent to the chat right away; the full answer follows when you are done.",
	" - Do not repeat that acknowledgement in the final answer, and do not acknowledge replies that need no tools."
);

/** Said when the model starts a long job without acknowledging it itself. */
const FALLBACK_ACKNOWLEDGEMENTS = {
	vi: ["Đợi mình chút, để mình xem nhé…", "Để mình kiểm tra đã nha…", "Ok, mình tra thử ngay…"],
	en: ["Give me a moment, looking into it…", "On it, checking now…"]
};

/** Vietnamese if the text carries Vietnamese letters or tone marks, English otherwise. */
function fallbackAcknowledgement(text: string | null | undefined): string {
	const vietnamese = /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i.test(text ?? "");
	const pool = vietnamese ? FALLBACK_ACKNOWLEDGEMENTS.vi : FALLBACK_ACKNOWLEDGEMENTS.en;
	return pool[Math.floor(Math.random() * pool.length)]!;
}

/** Model passes per chat-mode reply, the forced no-tools answer included. */
const CHAT_MAX_PASSES = 6;

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

	/** The queued turn was asked for by name (mention or wake keyword), not picked up from the flow. */
	explicitTrigger: boolean;

	history: HistoryEntry[];

	/** Key this conversation is stored under: the channel id, or `b:<channel>` for /b. */
	key: string;

	/** Rolling summary of every turn compacted out of `history`. */
	summary: string;

	private nextSeq: number;
	private currentTurn: number;

	private turnChain: Promise<unknown> = Promise.resolve();

	/**
	 * Create a new chat conversation.
	 */
	constructor(channel: ConversationChannel, model: string, instructions: string, mode: ConversationMode, {
		nickname = "ChatGPT",
		reasoningEffort = "medium",
		key = channel.id
	}: { nickname?: string; reasoningEffort?: string; key?: string } = {}) {
		this.channel = channel;
		this.key = key;
		this.summary = "";
		this.nextSeq = 1;
		this.currentTurn = 0;
		this.model = model;
		this.mode = mode;
		this.nickname = nickname;
		this.reasoningEffort = reasoningEffort;
		this.lastMessage = null;

		// Resolve the bot's display name for this guild (nickname if set, otherwise username).
		const botName = channel.botName
			|| ((channel.guild)
				? (channel.guild.members.cache.get(discord.user!.id)?.displayName || discord.user?.username || "")
				: (discord.user?.username || ""));

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
		this.explicitTrigger = false;

		this.instructions += "\n" + (channel.surfaceInstructions ?? ChatConversation.discordInstructions());
		this.instructions += "\n\n" + ACKNOWLEDGE_RULE;

		this.history = [];

		this.log.info(`New conversation created in ${this.mode} mode, using model ${this.model}`);
	}

	/** The message schema and formatting rules of a Discord channel. */
	static discordInstructions(): string {
		return lines(
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
			"Custom server emojis are available; call list_emojis to see their names before using one."
		);
	}

	get platform() {
		return this.channel.platform ?? "discord";
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
		await this.compactIfNeeded();

		const context = this.buildRuntimeContext(message, { forceRespond });
		const tools = await getToolDefinitions(context);
		const developerMessages: ConversationItem[] = [
			...await buildContextMessages(context),
			...await buildDeveloperMessages(context)
		];
		let input: ConversationItem[] = prepareHistory(this.history);

		if (this.summary) {
			developerMessages.unshift({
				kind: "message",
				role: "developer",
				content: [{ type: "text", text: `Summary of the earlier conversation in this channel:\n${this.summary}` }]
			});
		}

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

		return { context, input, tools };
	}

	/** Load persisted history and summary; called once when the conversation is created. */
	restore(): this {
		const stored = loadHistory(this.key);

		this.summary = stored.summary;
		this.history = stored.entries;
		this.nextSeq = (stored.entries.at(-1)?.seq ?? 0) + 1;
		this.currentTurn = stored.entries.at(-1)?.turn ?? 0;

		if (stored.entries.length > 0 || stored.summary)
			this.log.info(`Restored ${stored.entries.length} history item(s)${stored.summary ? " and a summary" : ""}.`);

		return this;
	}

	/**
	 * Fold the oldest turns into the rolling summary once history outgrows its
	 * budget. Whole turns only, the newest two always kept, and the result is
	 * cut to well under the budget so this does not run on every message.
	 */
	async compactIfNeeded(): Promise<void> {
		const budget = historyBudget(this.model);
		const total = this.history.reduce((sum, entry) => sum + (entry.tokens ?? estimateTokens(entry.item)), 0);

		if (total <= budget)
			return;

		const turns = [...new Set(this.history.map((entry) => entry.turn ?? 0))];
		const keepFrom = turns.length > 2 ? turns[turns.length - 2]! : turns[0]!;
		const target = budget * 0.6;
		let remaining = total;
		let foldThroughTurn: number | null = null;

		for (const turn of turns) {
			if (turn >= keepFrom || remaining <= target)
				break;

			remaining -= this.history
				.filter((entry) => (entry.turn ?? 0) === turn)
				.reduce((sum, entry) => sum + (entry.tokens ?? estimateTokens(entry.item)), 0);

			foldThroughTurn = turn;
		}

		if (foldThroughTurn === null)
			return;

		const folded = this.history.filter((entry) => (entry.turn ?? 0) <= foldThroughTurn!);
		const kept = this.history.filter((entry) => (entry.turn ?? 0) > foldThroughTurn!);
		const throughSeq = folded.at(-1)?.seq ?? 0;
		let summary = this.summary;

		try {
			summary = await this.provider.generateText({
				model: this.model,
				instructions: SUMMARY_INSTRUCTIONS,
				input: `Summary so far:\n${this.summary || "(none)"}\n\nConversation to fold in:\n${transcript(folded)}`
			}) || this.summary;
		} catch (err: any) {
			// Over budget either way; dropping the oldest turns without a fresh
			// summary loses less than refusing to answer.
			this.log.warn(`Summarizing older history failed, dropping it unsummarized: ${err?.message || err}`);
		}

		this.history = kept;
		this.summary = summary;
		compactHistory(this.key, summary, throughSeq);
		this.log.info(`Compacted ${folded.length} history item(s) into the summary (${total} → ${remaining} tokens).`);
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
		const entries: HistoryEntry[] = items.map((item) => {
			if (startsTurn(item))
				this.currentTurn += 1;

			return { item, timestamp, seq: this.nextSeq++, turn: this.currentTurn, tokens: estimateTokens(item) };
		});

		this.history.push(...entries);

		try {
			appendHistory(this.key, {
				guildId: this.channel.guild?.id ?? null,
				channelId: this.channel.id,
				mode: this.mode
			}, entries);
		} catch (err: any) {
			// The in-memory history still works; the turn is only lost on restart.
			this.log.error(`Failed to persist history: ${err?.message || err}`);
		}
	}

	/**
	 * Handle incomming message.
	 */
	async handle(message: IncomingMessage): Promise<this> {
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
		const botMentioned = message.mentionsBot ?? message.mentions.users.has(discord.user!.id);

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
		this.explicitTrigger = this.explicitTrigger || botMentioned || wakeupKeywordMatched;
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

		try {
			return await this.exclusive(() => this.generateReply({ activateChat }));
		} catch (err: any) {
			// A provider error used to leave `processing` stuck on, which muted
			// the channel until someone ran /clear.
			this.log.error(`Failed to generate a reply in channel ${this.channel.id}: ${err?.message || err}`);
			return null;
		} finally {
			this.processing = false;

			if (this.pendingProcess)
				this.scheduleProcess();
		}
	}

	private async generateReply({ activateChat }: { activateChat: boolean }): Promise<string | null> {
		this.log.info(`Start processing response for channel ${this.channel.id}.`);
		const forceRespond = this.forceRespondOnNextProcess;
		this.forceRespondOnNextProcess = false;
		const explicit = this.explicitTrigger;
		this.explicitTrigger = false;
		const progress = this.channel.progress;

		progress?.start(explicit);

		let sent = false;

		try {
			sent = await this.produceReply({ activateChat, forceRespond, explicit }) !== null;
			return sent ? this.lastReplyText : null;
		} finally {
			progress?.end(sent);
		}
	}

	/** Text of the last reply that went out, for `generateReply`'s return. */
	private lastReplyText: string | null = null;

	private async produceReply({ activateChat, forceRespond, explicit }: { activateChat: boolean; forceRespond: boolean; explicit: boolean }): Promise<string | null> {
		this.lastReplyText = null;

		// The first tool pass gets an acknowledgement out before the work: the
		// model's own when it wrote one, a stock one when the bot was addressed
		// directly and the model said nothing. An unprompted turn without one
		// stays quiet, since it may still end in [skip].
		let acknowledgement: Promise<void> | null = null;
		let acknowledgedText = "";

		const acknowledge = (preamble: string) => {
			if (acknowledgement)
				return;

			const own = preamble.trim();
			const text = own && !own.startsWith("[skip]")
				? own
				: (explicit || forceRespond) ? fallbackAcknowledgement(this.lastMessage?.content) : "";

			if (!text) {
				acknowledgement = Promise.resolve();
				return;
			}

			acknowledgedText = text;
			acknowledgement = this.deliver(text).then(() => undefined, (err: any) => {
				this.log.warn(`Failed to send the acknowledgement in channel ${this.channel.id}: ${err?.message || err}`);
			});
		};

		const request = await this.buildResponseRequest(this.lastMessage, { forceRespond });
		const provider = this.provider;
		const progress = this.channel.progress;

		const { response } = await runToolLoop({
			request: {
				model: this.model,
				instructions: this.instructions,
				input: request.input,
				tools: request.tools,
				reasoningEffort: this.getReasoningOptions()?.effort ?? null
			},
			context: request.context,
			maxPasses: CHAT_MAX_PASSES,
			call: (modelRequest) => provider.respond(modelRequest),
			onItems: (items) => this.pushHistory(...items),
			onToolCalls: (calls, preamble) => {
				acknowledge(preamble);
				progress?.tools(calls);
			},
			onToolResults: (calls, outputs) => progress?.toolsDone(calls, outputs)
		});

		let output_text = response?.outputText ?? "";
		this.log.info(`Got chat response: ${output_text}`);

		if (acknowledgement)
			await acknowledgement;

		// A model that repeats its acknowledgement as the answer has said it already.
		if (acknowledgedText && output_text.trim() === acknowledgedText)
			output_text = "";

		const trimmed = output_text.trim();

		if (trimmed.length === 0 || trimmed === "[skip]" || trimmed === "`[skip]`" || trimmed.startsWith("[skip]")) {
			this.chatActivated = false;
			this.skipStreak += 1;
			this.log.info(`Response was [skip], not sending message.`);
			return null;
		}

		if (activateChat)
			this.chatActivated = true;

		this.skipStreak = 0;

		if (!this.canSend()) {
			this.log.warn(`Missing SendMessages permission for channel ${this.channel.id}, skipping send.`);
			return null;
		}

		try {
			output_text = await this.deliver(output_text);
		} catch (err: any) {
			this.log.error(`Failed to send message to channel ${this.channel.id}: ${err.message}`);
			return null;
		}

		this.log.info(`Response sent to channel ${this.channel.id}.`);
		this.lastReplyText = output_text;
		return output_text;
	}

	canSend(): boolean {
		if (this.platform !== "discord" || this.channel instanceof DMChannel)
			return true;

		const perms = this.channel.permissionsFor?.(discord.user);
		return perms?.has("SendMessages") ?? false;
	}

	/** Send text to the channel the way the surface wants it; resolves to what was sent. */
	async deliver(text: string): Promise<string> {
		if (!this.canSend())
			throw new Error("missing SendMessages permission");

		if (this.platform === "discord") {
			const processed = this.processOutputEmojis(text);

			for (const chunk of splitMessage(processed))
				await this.channel.send!({ content: chunk });

			return processed;
		}

		// The surface splits and formats its own lines.
		await this.channel.send!({ content: text });
		return text;
	}

	/**
	 * Run one turn at a time. Chat mode already queues through `processing`,
	 * but assistant mode starts a completion per message, and two quick
	 * messages used to interleave their history.
	 */
	async exclusive<T>(work: () => Promise<T>): Promise<T> {
		const run = this.turnChain.then(work, work);
		this.turnChain = run.catch(() => undefined);
		return await run;
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
		if (message.describe)
			return JSON.stringify(message.describe());

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
