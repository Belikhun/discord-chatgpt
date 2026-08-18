import fs from "node:fs";
import { AttachmentBuilder, DMChannel, MediaGalleryBuilder, MessageFlags, TextDisplayBuilder } from "discord.js";
import { bold, code, emoji, formatTime, h3, mention, sh, space, timestampMessage } from "../format";
import { scope, type Logger } from "../logger";
import { env } from "../env";
import { ModelTrait } from "../ai/types";
import type { MessagePart, ModelResponse, StreamEvent, ToolCall, ToolResultItem } from "../ai/types";
import { runToolCalls } from "../tools/registry";
import type { ChatConversation } from "./ChatConversation";
import { breakAndFixMessage, checkClosingBlocks, MESSAGE_MAX_LENGTH } from "./messageSplitter";
import type { IncomingMessage, MessageHandle } from "./types";

const { THINKING_MESSAGE, IMAGE_GENERATING_MESSAGE } = env;

const GENERATING_PLACEHOLDER = fs.readFileSync("./assets/generating_placeholder.gif");

type TimelineEntryType = "reasoning" | "assistant" | "tool";
type TimelineEntryStatus = "thinking" | "calling" | "success" | "error";

interface TimelineEntry {
	type: TimelineEntryType;
	title: string;
	detail: string;
	text: string;
	status: TimelineEntryStatus;
}

export class ChatCompletion {
	conversation: ChatConversation;
	originalMessage: IncomingMessage;
	author: IncomingMessage["author"];
	channelName: string;
	log: Logger;
	model: string;

	reasoning: string;
	inResponse: boolean;
	hasUpdate: boolean;
	updating: boolean;

	currentResponse: MessageHandle | null;

	isInCodeblock: boolean;
	codeblockHeader: string | null;
	isInCode: boolean;
	responseBuffer: string;

	responses: string[];
	responseIndex: number;
	sendNextMessage: boolean;

	imageGeneration: false | "inprogress" | "generating" | "partial" | "completed";
	images: { [index: string]: { url: string; content_type: string } };
	files: { [index: string]: AttachmentBuilder };
	generationPrompt: string[];

	toolCallsUsed: Set<string>;
	toolCallStatus: Map<string, "calling" | "success" | "error">;
	timelineEntries: TimelineEntry[];
	toolTimelineIndex: Map<string, number>;
	toolInvocationCounter: number;
	reasoningTimelineIndex: number | null;

	gallery: MediaGalleryBuilder | null;
	completed: boolean;

	startTime!: number;
	startDate!: Date;
	thinkingReply: MessageHandle | null = null;
	thinkingMessageComponent?: TextDisplayBuilder;

	/**
	 * Create a new chat completion instance.
	 */
	constructor(conversation: ChatConversation, message: IncomingMessage, model: string) {
		this.conversation = conversation;
		this.originalMessage = message;
		this.author = this.originalMessage.author;

		this.channelName = (message.channel instanceof DMChannel)
				? `${message.author.displayName}'s DM`
				: message.channel.name;

		this.log = scope(`chat:${message.id}`);

		this.model = model;

		this.reasoning = "";

		this.inResponse = false;
		this.hasUpdate = false;
		this.updating = false;

		this.currentResponse = null;

		this.isInCodeblock = false;
		this.codeblockHeader = null;
		this.isInCode = false;
		this.responseBuffer = "";

		this.responses = [];
		this.responseIndex = 0;
		this.sendNextMessage = false;

		this.imageGeneration = false;
		this.images = {};
		this.files = {};
		this.generationPrompt = [];

		this.toolCallsUsed = new Set();
		this.toolCallStatus = new Map();
		this.timelineEntries = [];
		this.toolTimelineIndex = new Map();
		this.toolInvocationCounter = 0;
		this.reasoningTimelineIndex = null;

		this.gallery = null;
		this.completed = false;
	}

	get runtime(): number {
		return (performance.now() - this.startTime) / 1000;
	}

	getReasoningPreview(): string {
		if (this.reasoning.length === 0)
			return "";

		const words = this.reasoning.split(" ");
		if (words.length > 80)
			return "..." + words.slice(-80).join(" ");

		return words.join(" ");
	}

	getToolStatusLines(): string[] {
		const lines: string[] = [];

		if (this.toolCallsUsed.size === 0)
			return lines;

		for (const toolName of this.toolCallsUsed) {
			const status = this.toolCallStatus.get(toolName) || "calling";
			const statusEmoji = (status === "success")
				? emoji("acok")
				: ((status === "error")
					? emoji("acerror")
					: emoji("ganyuroll", true));
			lines.push(`-# > ${statusEmoji}  **${toolName}**`);
		}

		return lines;
	}

	pushTimelineEntry({ type, title = "", detail = "", text = "", status = "thinking" }: Partial<TimelineEntry> & { type: TimelineEntryType }): number {
		this.timelineEntries.push({ type, title, detail, text, status });
		return this.timelineEntries.length - 1;
	}

	updateTimelineEntry(index: number, { detail, text, status }: { detail?: string; text?: string; status?: TimelineEntryStatus } = {}): void {
		const entry = this.timelineEntries[index];
		if (!entry)
			return;

		if (typeof detail === "string")
			entry.detail = detail;

		if (typeof text === "string")
			entry.text = text;

		if (status)
			entry.status = status;
	}

	ensureReasoningTimelineEntry(): number {
		if (this.reasoningTimelineIndex === null) {
			this.reasoningTimelineIndex = this.pushTimelineEntry({
				type: "reasoning",
				title: "Suy luận",
				detail: "Đang phân tích yêu cầu...",
				status: "thinking"
			});
		}

		return this.reasoningTimelineIndex;
	}

	commitAssistantBuffer(): void {
		const content = this.responseBuffer.trim();
		if (!content)
			return;

		this.pushTimelineEntry({
			type: "assistant",
			text: content,
			status: "success"
		});

		this.responseBuffer = "";
		this.isInCode = false;
		this.isInCodeblock = false;
		this.codeblockHeader = null;
	}

	buildStreamingMessageContent(content: string = ""): string {
		const sections: string[] = [];
		const trimmedContent = (content || "").trim();
		let toolLines: string[] = [];

		const flushToolLines = () => {
			if (toolLines.length === 0)
				return;

			sections.push(toolLines.join("\n"));
			toolLines = [];
		};

		for (const entry of this.timelineEntries) {
			if (entry.type === "reasoning") {
				flushToolLines();
				if (entry.status === "thinking" && entry.detail)
					sections.push(`-# > ${entry.detail}`);
				continue;
			}

			if (entry.type === "assistant") {
				flushToolLines();
				if (entry.text)
					sections.push(entry.text);
				continue;
			}

			if (entry.type === "tool") {
				const statusEmoji = (entry.status === "success")
					? emoji("acok")
					: ((entry.status === "error")
						? emoji("acerror")
						: emoji("ganyuroll", true));
				toolLines.push(`-# > ${statusEmoji}  **${entry.title}**`);
			}
		}

		flushToolLines();

		if (trimmedContent.length > 0)
			sections.push(trimmedContent);

		return sections.join("\n\n").trim();
	}

	thinkingMessage(): TextDisplayBuilder {
		if (!this.thinkingMessageComponent)
			this.thinkingMessageComponent = new TextDisplayBuilder();

		const thinking = (this.imageGeneration)
			? IMAGE_GENERATING_MESSAGE.replace("{@}", mention(this.author)).replace("{NICK}", this.conversation.nickname)
			: THINKING_MESSAGE.replace("{@}", mention(this.author)).replace("{NICK}", this.conversation.nickname);

		const lines = [
			`### ${code(this.model, true)} ${space()}${emoji("minecraft_clock", true)} ${timestampMessage(this.startDate, "R")}`,
			`## ${emoji("loading", true)} ${bold(thinking)}`
		];

		const reasoningPreview = this.getReasoningPreview();
		if (reasoningPreview.length > 0)
			lines.push(sh(`> ${reasoningPreview}`));

		lines.push(...this.getToolStatusLines());

		return this.thinkingMessageComponent.setContent(lines.join("\n"));
	}

	footer(): string {
		if (this.completed)
			return sh(`${emoji("resting", true)} ${code(this.model, true)} ${space()}${emoji("minecraft_clock", true)} ${formatTime(this.runtime)}`);

		return h3(`${emoji("loading", true)} ${code(this.model, true)} ${space()}${emoji("minecraft_clock", true)} ${timestampMessage(this.startDate, "R")}`);
	}

	isReasoningModel(): boolean {
		return this.conversation.provider.hasTrait(this.model, ModelTrait.Thinking);
	}

	prepareImageIndex(index: number): AttachmentBuilder {
		const attachment = new AttachmentBuilder(GENERATING_PLACEHOLDER, {
			name: `generated${index}.gif`
		});

		this.files[`g${index}`] = attachment;
		this.images[`g${index}`] = {
			url: `attachment://generated${index}.gif`,
			content_type: "image/gif"
		};

		return attachment;
	}

	updateImageIndex(index: number, imageBase64: string, { format }: { size?: string; format?: string } = {}): AttachmentBuilder {
		const attachment = this.files[`g${index}`] as AttachmentBuilder;
		const image = this.images[`g${index}`] as { url: string; content_type: string };

		const buffer = Buffer.from(imageBase64, "base64");

		attachment.setFile(buffer, `generated${index}.${format}`);
		attachment.setName(`generated${index}.${format}`);
		image.url = `attachment://generated${index}.${format}`;
		image.content_type = `image/${format}`;
		return attachment;
	}

	async start(): Promise<void> {
		this.startTime = performance.now();
		this.startDate = new Date();
		this.log.info(`Chat completion started`);
		this.originalMessage.channel.sendTyping();
		this.toolCallsUsed.clear();
		this.toolCallStatus.clear();

		this.thinkingReply = await this.originalMessage.reply({
			flags: MessageFlags.IsComponentsV2,
			components: [this.thinkingMessage()]
		});

		const content: MessagePart[] = [];

		if (this.originalMessage.content.length > 0)
			content.push({ type: "text", text: await this.conversation.processMessage(this.originalMessage) });

		for (const attachment of this.originalMessage.attachments.values()) {
			if (attachment.contentType?.startsWith("image")) {
				content.push({
					type: "image",
					url: attachment.url
				});

				continue;
			}
		}

		this.conversation.pushHistory({
			kind: "message",
			role: "user",
			content
		});
		this.conversation.lastMessage = this.originalMessage;

		const request = await this.conversation.buildResponseRequest(this.originalMessage);
		const runtimeContext = request.context;
		const provider = this.conversation.provider;
		const reasoningEffort = this.conversation.getReasoningOptions()?.effort ?? null;

		let input = request.input;

		let pass = 0;
		const maxPasses = 20;
		let finalResponse: ModelResponse | null = null;
		let toolCalls: ToolCall[] = [];

		while (pass < maxPasses) {
			const result = await this.runResponseStream(provider.stream({
				model: this.model,
				instructions: this.conversation.instructions,
				input,
				tools: request.tools,
				reasoningEffort,
				enableWebSearch: true,
				enableImageGeneration: true
			}));

			finalResponse = result;
			toolCalls = result?.toolCalls || [];

			if (finalResponse?.items?.length) {
				this.conversation.pushHistory(...finalResponse.items);
			}

			if (!toolCalls || toolCalls.length === 0) {
				break;
			}

			pass += 1;
			if (pass >= maxPasses) {
				this.log.warn(`Tool loop reached max passes (${maxPasses}), stopping further tool calls.`);
				break;
			}

			this.log.info(`Processing ${toolCalls.length} tool call(s).`);

			const toolOutputs = await runToolCalls(toolCalls, {
				...runtimeContext
			});

			this.markToolResults(toolCalls, toolOutputs);
			this.log.info(`Tool calls completed: ${toolCalls.map((call) => call.name).join(", ")}`);

			this.conversation.pushHistory(...toolOutputs);

			input = input.concat(finalResponse?.items || [], toolOutputs);
		}

		if (!this.inResponse && this.responses.length === 0 && this.responseBuffer.trim().length === 0) {
			this.handleOutput("*Không có nội dung phản hồi*");
		}

		this.completed = true;
		this.deferUpdate();
		this.log.success(`Chat completed. Runtime ${formatTime(this.runtime)}`);
	}

	async runResponseStream(stream: AsyncGenerator<StreamEvent>): Promise<ModelResponse | null> {
		let finalResponse: ModelResponse | null = null;

		for await (const event of stream) {
			switch (event.type) {
				case "reasoning_delta": {
					this.handleReasoning(event.delta);
					break;
				}

				case "reasoning_part_added": {
					this.ensureReasoningTimelineEntry();

					if (this.reasoning.length > 0)
						this.handleReasoning(" ");

					break;
				}

				case "text_delta": {
					this.handleOutput(event.delta);
					break;
				}

				case "tool_call_added": {
					this.markToolCalled(event);
					break;
				}

				case "image_in_progress": {
					this.imageGeneration = "inprogress";
					this.log.info(`Started generating image... [${event.index}]`);
					this.prepareImageIndex(event.index);
					this.deferUpdate();
					break;
				}

				case "image_generating": {
					this.imageGeneration = "generating";
					this.log.info(`Image generation in progress... [${event.index}]`);
					this.deferUpdate();
					break;
				}

				case "image_partial": {
					this.imageGeneration = "partial";
					this.updateImageIndex(event.index, event.imageBase64, {
						size: event.size,
						format: event.format
					});

					this.deferUpdate();
					break;
				}

				case "image_completed": {
					this.imageGeneration = "completed";
					this.updateImageIndex(event.index, event.imageBase64, {
						size: event.size,
						format: event.format
					});

					this.generationPrompt.push(event.revisedPrompt || "");
					this.handleOutput(sh(`> ${event.revisedPrompt}`));
					this.log.info(`Image generation completed [${event.index}]`);
					this.deferUpdate();
					break;
				}

				case "completed": {
					if (this.reasoningTimelineIndex !== null) {
						this.updateTimelineEntry(this.reasoningTimelineIndex, {
							detail: this.getReasoningPreview() || "Đã hoàn tất suy luận.",
							status: "success"
						});
					}

					finalResponse = event.response;
					break;
				}

				default:
					break;
			}
		}

		return finalResponse;
	}

	markToolCalled(tool: string | { callId?: string | null; name?: string }): void {
		const toolName = (typeof tool === "string") ? tool : tool?.name;
		if (!toolName)
			return;

		const toolKey = (typeof tool === "object" && tool?.callId)
			? tool.callId
			: `${toolName}-${this.toolInvocationCounter++}`;

		if (this.inResponse)
			this.commitAssistantBuffer();

		if (!this.toolCallsUsed.has(toolName))
			this.toolCallsUsed.add(toolName);

		this.toolCallStatus.set(toolName, "calling");
		this.toolTimelineIndex.set(toolKey, this.pushTimelineEntry({
			type: "tool",
			title: `Gọi công cụ ${toolName}`,
			detail: "Đang chờ kết quả...",
			status: "calling"
		}));
		this.deferUpdate();
	}

	markToolResults(toolCalls: ToolCall[], toolOutputs: ToolResultItem[]): void {
		if (!Array.isArray(toolCalls) || !Array.isArray(toolOutputs))
			return;

		const outputByCallId = new Map<string, ToolResultItem>();
		for (const output of toolOutputs) {
			if (output?.callId)
				outputByCallId.set(output.callId, output);
		}

		for (const call of toolCalls) {
			const toolName = call?.name;
			const toolKey = call?.id || toolName;
			const output = outputByCallId.get(call?.id);
			let ok = false;

			if (output?.output) {
				try {
					const parsed = JSON.parse(output.output);
					ok = !!parsed?.ok;
				} catch {
					ok = false;
				}
			}

			if (toolName) {
				this.toolCallStatus.set(toolName, ok ? "success" : "error");
				const timelineIndex = this.toolTimelineIndex.get(toolKey);
				if (typeof timelineIndex === "number") {
					this.updateTimelineEntry(timelineIndex, {
						detail: ok ? "Thực thi thành công." : "Thực thi thất bại hoặc trả về lỗi.",
						status: ok ? "success" : "error"
					});
				}
			}
		}

		this.deferUpdate();
	}

	/**
	 * Handle reasoning output
	 */
	handleReasoning(delta: string): void {
		delta = delta
			.replaceAll("**", "")
			.replaceAll("*", "")
			.replaceAll(/\`\`\`(.*)\n/gm, " ")
			.replaceAll("```", "")
			.replaceAll("`", "")
			.replaceAll("\n\n", " ")
			.replaceAll("\n", " ");

		this.reasoning += delta;
		this.updateTimelineEntry(this.ensureReasoningTimelineEntry(), {
			detail: this.getReasoningPreview(),
			status: "thinking"
		});
		this.deferUpdate();
	}

	/**
	 * Handle response output
	 */
	handleOutput(delta: string): void {
		if (!this.inResponse) {
			// Re-use thinking reply message.
			this.currentResponse = this.thinkingReply;
			this.thinkingReply = null;
			this.inResponse = true;
		}

		const newResponse = this.responseBuffer + delta;

		if (newResponse.length > MESSAGE_MAX_LENGTH) {
			const split = breakAndFixMessage(newResponse, MESSAGE_MAX_LENGTH);
			this.responses[this.responseIndex] = split.splitted;

			this.responseBuffer = split.leftover;
			this.isInCode = split.leftoverInfo.isInCode;
			this.isInCodeblock = split.leftoverInfo.isInCodeblock;
			this.codeblockHeader = split.leftoverInfo.codeblockHeader;
			this.sendNextMessage = true;
		} else {
			const state = checkClosingBlocks(newResponse);
			this.responseBuffer = newResponse;
			this.isInCode = state.isInCode;
			this.isInCodeblock = state.isInCodeblock;
			this.codeblockHeader = state.codeblockHeader;
		}

		this.deferUpdate();
	}

	deferUpdate(): this {
		this.hasUpdate = true;

		if (!this.updating)
			this.update();

		return this;
	}

	async update(): Promise<void> {
		this.hasUpdate = false;
		this.updating = true;
		this.log.info(`Pushing update to discord...`);

		const components: any[] = [];
		let files: AttachmentBuilder[] = [];

		if (this.imageGeneration && this.responseIndex == 0) {
			if (!this.gallery) {
				this.gallery = new MediaGalleryBuilder();
			} else {
				this.gallery.spliceItems(0, this.gallery.items.length);
			}

			for (const image of Object.values(this.images)) {
				this.gallery.addItems({
					media: image
				});
			}

			components.push(this.gallery);
			files = Object.values(this.files);
		}

		if (!this.inResponse) {
			components.push(this.thinkingMessage());

			await this.thinkingReply!.edit({
				flags: MessageFlags.IsComponentsV2,
				components,
				files
			});
		} else {
			const textContent = new TextDisplayBuilder();
			components.push(textContent);

			if (this.responses[this.responseIndex]) {
				const processed = this.conversation?.processOutputEmojis
					? this.conversation.processOutputEmojis(this.responses[this.responseIndex] as string)
					: this.responses[this.responseIndex];
				textContent.setContent(processed || "*Đang tạo phản hồi...*");
			}

			if (this.sendNextMessage) {
				this.currentResponse!.edit({
					flags: MessageFlags.IsComponentsV2,
					components,
					files
				});

				this.responseIndex += 1;
				this.currentResponse = null;
				this.sendNextMessage = false;
			}

			let content = this.responseBuffer;

			if (this.isInCodeblock) {
				// Close opening codeblock.
				content += `\n\`\`\``;
			} else if (this.isInCode) {
				// Close opening inline code.
				content += `\``;
			}

			const processed = this.conversation?.processOutputEmojis
				? this.conversation.processOutputEmojis(content)
				: content;
			textContent.setContent(this.buildStreamingMessageContent(processed) || "*Đang tạo phản hồi...*");
			const footer = new TextDisplayBuilder().setContent(this.footer());
			components.push(footer);

			if (!this.currentResponse) {
				this.currentResponse = await this.originalMessage.channel.send({
					flags: MessageFlags.IsComponentsV2,
					components,
					files
				});
			} else {
				await this.currentResponse.edit({
					flags: MessageFlags.IsComponentsV2,
					components,
					files
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
