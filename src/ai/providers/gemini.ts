import { GoogleGenAI, ThinkingLevel, type Content, type FunctionDeclaration, type Part, type Schema, type Tool as GeminiTool } from "@google/genai";
import type { ProviderConfig } from "../../env";
import { scope } from "../../logger";
import { extractItemTexts } from "../registry";
import { ModelTrait } from "../types";
import type {
	AIProvider,
	ConversationItem,
	ModelInfo,
	ModelRequest,
	ModelResponse,
	ProviderItem,
	ReasoningEffort,
	StreamEvent,
	ToolCall,
	ToolDefinition
} from "../types";

const log = scope("gemini");

const {
	Thinking,
	FunctionCalling,
	WebSearch,
	ViewImage,
	ViewVideo,
	AnalyzeAudio,
	ReadDocument,
	GenerateImage
} = ModelTrait;

/** Gemini's text models are natively multimodal on the way in. */
const MULTIMODAL_IN: readonly ModelTrait[] = [ViewImage, ViewVideo, AnalyzeAudio, ReadDocument];

/** What every general-purpose Gemini chat model can do. */
const CHAT_TRAITS: readonly ModelTrait[] = [Thinking, FunctionCalling, WebSearch, ...MULTIMODAL_IN];

/**
 * Image-output ("Nano Banana") models return pictures as inline data rather
 * than exposing an image tool, and accept neither function tools nor search
 * grounding alongside that.
 */
const IMAGE_TRAITS: readonly ModelTrait[] = [Thinking, GenerateImage, ViewImage, ReadDocument];

/**
 * Model catalogue, newest first. TTS, music, robotics and computer-use variants
 * are omitted, as are the Gemini 2.5 models — the API rejects those for keys
 * created after their retirement.
 */
const CATALOGUE: readonly { id: string; displayName: string; traits: readonly ModelTrait[] }[] = [
	{ id: "gemini-3.7-flash", displayName: "Gemini 3.7 Flash", traits: CHAT_TRAITS },
	{ id: "gemini-3.6-flash", displayName: "Gemini 3.6 Flash", traits: CHAT_TRAITS },
	{ id: "gemini-3.5-flash", displayName: "Gemini 3.5 Flash", traits: CHAT_TRAITS },
	{ id: "gemini-3.5-flash-lite", displayName: "Gemini 3.5 Flash Lite", traits: CHAT_TRAITS },
	{ id: "gemini-3.1-pro-preview", displayName: "Gemini 3.1 Pro Preview", traits: CHAT_TRAITS },
	{ id: "gemini-3.1-flash-lite", displayName: "Gemini 3.1 Flash Lite", traits: CHAT_TRAITS },
	{ id: "gemini-3-flash-preview", displayName: "Gemini 3 Flash Preview", traits: CHAT_TRAITS },
	{ id: "gemini-pro-latest", displayName: "Gemini Pro Latest", traits: CHAT_TRAITS },
	{ id: "gemini-flash-latest", displayName: "Gemini Flash Latest", traits: CHAT_TRAITS },
	{ id: "gemini-flash-lite-latest", displayName: "Gemini Flash-Lite Latest", traits: CHAT_TRAITS },
	{ id: "gemini-3-pro-image", displayName: "Nano Banana Pro", traits: IMAGE_TRAITS },
	{ id: "gemini-3.1-flash-image", displayName: "Nano Banana 2", traits: IMAGE_TRAITS },
	{ id: "gemini-3.1-flash-lite-image", displayName: "Nano Banana 2 Lite", traits: IMAGE_TRAITS }
];

/** Largest image we are willing to inline into a request. */
const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Google Gemini provider, backed by the Gemini Developer API.
 *
 * Model turns are stored opaquely as Gemini `Content` objects and replayed
 * verbatim, which keeps thought signatures and function calls intact across
 * tool passes. Items produced by a different provider are downconverted to
 * plain text, so switching models mid-conversation still works.
 */
export class GeminiProvider implements AIProvider {
	readonly id = "gemini";
	readonly models: readonly ModelInfo[] = CATALOGUE.map((entry) => ({
		id: entry.id,
		displayName: entry.displayName,
		provider: "gemini",
		traits: entry.traits
	}));

	private client: GoogleGenAI;

	constructor(config: ProviderConfig) {
		this.client = new GoogleGenAI({
			apiKey: config.API_KEY,
			...(config.BASE_URL ? { httpOptions: { baseUrl: config.BASE_URL } } : {})
		});
	}

	getModelInfo(model: string): ModelInfo {
		const known = this.models.find((entry) => entry.id === model);
		if (known)
			return known;

		// Not catalogued: assume the shape of a current Gemini chat model, and
		// treat an "-image" suffix as image output.
		return {
			id: model,
			displayName: model,
			provider: this.id,
			traits: model.endsWith("-image") ? IMAGE_TRAITS : CHAT_TRAITS
		};
	}

	hasTrait(model: string, trait: ModelTrait): boolean {
		return this.getModelInfo(model).traits.includes(trait);
	}

	/**
	 * True when the model takes `thinkingLevel`. Only the Gemini 2.5 family
	 * used the older numeric `thinkingBudget`, so anything else — including the
	 * unversioned `-latest` aliases — gets the level.
	 */
	private usesThinkingLevel(model: string): boolean {
		return !/^gemini-2\.5/.test(model);
	}

	private toThinkingLevel(effort: ReasoningEffort | string): ThinkingLevel {
		switch (effort) {
			case "minimal": return ThinkingLevel.MINIMAL;
			case "low": return ThinkingLevel.LOW;
			case "high": return ThinkingLevel.HIGH;
			default: return ThinkingLevel.MEDIUM;
		}
	}

	private toThinkingBudget(effort: ReasoningEffort | string): number {
		switch (effort) {
			case "minimal": return 0;
			case "low": return 1024;
			case "high": return 24576;
			// -1 lets the model decide how long to think.
			default: return -1;
		}
	}

	/**
	 * Convert a JSON-Schema parameter block into Gemini's schema dialect:
	 * uppercase types, `nullable` instead of union types, and no
	 * `additionalProperties`.
	 */
	private toGeminiSchema(schema: Record<string, any>): Schema {
		const converted: Record<string, any> = {};

		if (Array.isArray(schema.type)) {
			const types = schema.type.filter((type: string) => type !== "null");

			converted.type = String(types[0] ?? "string").toUpperCase();
			if (types.length < schema.type.length)
				converted.nullable = true;
		} else if (typeof schema.type === "string") {
			converted.type = schema.type.toUpperCase();
		}

		for (const key of ["description", "enum", "required", "format", "title", "default", "minimum", "maximum", "minItems", "maxItems", "nullable"]) {
			if (schema[key] !== undefined)
				converted[key] = schema[key];
		}

		if (schema.properties) {
			converted.properties = Object.fromEntries(
				Object.entries(schema.properties as Record<string, any>)
					.map(([name, value]) => [name, this.toGeminiSchema(value)])
			);
		}

		if (schema.items)
			converted.items = this.toGeminiSchema(schema.items);

		if (Array.isArray(schema.anyOf))
			converted.anyOf = schema.anyOf.map((entry: Record<string, any>) => this.toGeminiSchema(entry));

		return converted as Schema;
	}

	private toFunctionDeclaration(tool: ToolDefinition): FunctionDeclaration {
		return {
			name: tool.name,
			description: tool.description,
			parameters: this.toGeminiSchema(tool.parameters) as FunctionDeclaration["parameters"]
		};
	}

	private serializeTools(request: ModelRequest): GeminiTool[] | undefined {
		const tools: GeminiTool[] = [];

		// Image-output models reject tools outright, so respect the trait rather
		// than sending declarations that would fail the request.
		if (request.tools.length > 0 && this.hasTrait(request.model, FunctionCalling))
			tools.push({ functionDeclarations: request.tools.map((tool) => this.toFunctionDeclaration(tool)) });

		// Google Search grounding cannot be combined with function declarations,
		// so our own tools win when both are on the table.
		if (request.enableWebSearch && this.hasTrait(request.model, WebSearch) && tools.length === 0)
			tools.push({ googleSearch: {} });

		return (tools.length > 0) ? tools : undefined;
	}

	/**
	 * Fetch an image and inline it, since Gemini cannot read arbitrary URLs.
	 * Falls back to a textual reference when the download fails.
	 */
	private async inlineImage(url: string): Promise<Part> {
		try {
			const response = await fetch(url, {
				// Some CDNs reject requests without a user agent.
				headers: { "User-Agent": "discord-chatgpt" }
			});

			if (!response.ok)
				throw new Error(`HTTP ${response.status}`);

			const buffer = await response.arrayBuffer();
			if (buffer.byteLength > MAX_INLINE_IMAGE_BYTES)
				throw new Error(`image too large (${buffer.byteLength} bytes)`);

			return {
				inlineData: {
					mimeType: response.headers.get("content-type") || "image/png",
					data: Buffer.from(buffer).toString("base64")
				}
			};
		} catch (err: any) {
			log.warn(`Không thể tải ảnh cho Gemini (${url}): ${err.message}`);
			return { text: `[image: ${url}]` };
		}
	}

	/**
	 * Map tool call IDs to their function names, which Gemini requires when
	 * sending a function response back.
	 */
	private collectCallNames(items: ConversationItem[]): Map<string, string> {
		const names = new Map<string, string>();

		for (const item of items) {
			if (item.kind !== "provider" || item.provider !== this.id)
				continue;

			const parts = (item.item as Content).parts || [];
			let index = 0;

			for (const part of parts) {
				const call = part.functionCall;
				if (!call?.name)
					continue;

				names.set(call.id || `${call.name}#${index}`, call.name);
				index++;
			}
		}

		return names;
	}

	private async serializeContents(items: ConversationItem[]): Promise<Content[]> {
		const contents: Content[] = [];
		const callNames = this.collectCallNames(items);

		for (const item of items) {
			switch (item.kind) {
				case "message": {
					const parts: Part[] = [];

					for (const part of item.content) {
						if (part.type === "image")
							parts.push(await this.inlineImage(part.url));
						else
							parts.push({ text: part.text });
					}

					// Gemini only knows "user" and "model"; developer notes are
					// context we hand to the model as user turns.
					contents.push({
						role: (item.role === "assistant") ? "model" : "user",
						parts
					});

					break;
				}

				case "provider": {
					if (item.provider === this.id) {
						contents.push(item.item as Content);
						break;
					}

					// History from another provider: keep the text, drop the
					// provider-specific structure.
					const text = extractItemTexts(item).join("\n").trim();
					if (text)
						contents.push({ role: "model", parts: [{ text }] });

					break;
				}

				case "tool_result": {
					let response: Record<string, unknown>;

					try {
						response = JSON.parse(item.output);
					} catch {
						response = { output: item.output };
					}

					const name = callNames.get(item.callId) || item.callId.split("#")[0] || "unknown";

					contents.push({
						role: "user",
						parts: [{
							functionResponse: {
								...(item.callId.includes("#") ? {} : { id: item.callId }),
								name,
								response
							}
						}]
					});

					break;
				}
			}
		}

		return contents;
	}

	private async buildRequest(request: ModelRequest): Promise<Record<string, any>> {
		const config: Record<string, any> = {};

		if (request.instructions)
			config.systemInstruction = request.instructions;

		const tools = this.serializeTools(request);
		if (tools)
			config.tools = tools;

		if (request.reasoningEffort && this.hasTrait(request.model, Thinking)) {
			config.thinkingConfig = this.usesThinkingLevel(request.model)
				? { includeThoughts: true, thinkingLevel: this.toThinkingLevel(request.reasoningEffort) }
				: { includeThoughts: true, thinkingBudget: this.toThinkingBudget(request.reasoningEffort) };
		}

		if (this.hasTrait(request.model, GenerateImage))
			config.responseModalities = ["TEXT", "IMAGE"];

		return {
			model: request.model,
			contents: await this.serializeContents(request.input),
			config
		};
	}

	/** Text of a model turn, excluding thought summaries. */
	private extractText(parts: Part[]): string {
		return parts
			.filter((part) => !part.thought && typeof part.text === "string")
			.map((part) => part.text)
			.join("");
	}

	private extractToolCalls(parts: Part[]): ToolCall[] {
		const calls: ToolCall[] = [];

		for (const part of parts) {
			const call = part.functionCall;
			if (!call?.name)
				continue;

			calls.push({
				// Gemini omits IDs on the Developer API, so we derive a stable
				// one from the call's position among the turn's function calls.
				id: call.id || `${call.name}#${calls.length}`,
				name: call.name,
				arguments: JSON.stringify(call.args ?? {})
			});
		}

		return calls;
	}

	private toModelResponse(parts: Part[]): ModelResponse {
		const items: ConversationItem[] = (parts.length > 0)
			? [{ kind: "provider", provider: this.id, item: { role: "model", parts } }]
			: [];

		return {
			items,
			outputText: this.extractText(parts),
			toolCalls: this.extractToolCalls(parts)
		};
	}

	async respond(request: ModelRequest): Promise<ModelResponse> {
		const response = await this.client.models.generateContent(await this.buildRequest(request) as any);
		const parts = response.candidates?.[0]?.content?.parts || [];

		return this.toModelResponse(parts as Part[]);
	}

	async *stream(request: ModelRequest): AsyncGenerator<StreamEvent> {
		const stream = await this.client.models.generateContentStream(await this.buildRequest(request) as any);

		const parts: Part[] = [];
		let imageIndex = 0;

		for await (const chunk of stream) {
			for (const part of (chunk.candidates?.[0]?.content?.parts || []) as Part[]) {
				parts.push(part);

				if (typeof part.text === "string" && part.text.length > 0) {
					yield (part.thought)
						? { type: "reasoning_delta", delta: part.text }
						: { type: "text_delta", delta: part.text };
				}

				const call = part.functionCall;
				if (call?.name) {
					// Mirrors extractToolCalls()' ID synthesis so the streamed
					// call and the one in the final response share an ID.
					yield {
						type: "tool_call_added",
						callId: call.id || `${call.name}#${this.extractToolCalls(parts).length - 1}`,
						name: call.name
					};
				}

				const inline = part.inlineData;
				if (inline?.data && inline.mimeType?.startsWith("image/")) {
					const index = imageIndex++;
					const format = inline.mimeType.split("/")[1] || "png";

					// The renderer expects a placeholder slot before the final
					// picture lands, so open one for every image we receive.
					yield { type: "image_in_progress", index };
					yield {
						type: "image_completed",
						index,
						imageBase64: inline.data,
						format
					};
				}
			}
		}

		yield { type: "completed", response: this.toModelResponse(parts) };
	}

	async generateText({ model, instructions, input }: { model: string; instructions: string; input: string }): Promise<string> {
		const response = await this.client.models.generateContent({
			model,
			contents: [{ role: "user", parts: [{ text: input }] }],
			config: instructions ? { systemInstruction: instructions } : {}
		});

		const parts = (response.candidates?.[0]?.content?.parts || []) as Part[];
		return (response.text || this.extractText(parts) || "").trim();
	}

	extractTexts(item: ProviderItem): string[] {
		const parts = (item.item as Content)?.parts;
		if (!Array.isArray(parts))
			return [];

		return parts
			.filter((part) => !part.thought && typeof part.text === "string" && part.text.length > 0)
			.map((part) => part.text as string);
	}
}
