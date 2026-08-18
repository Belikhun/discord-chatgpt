import OpenAI from "openai";
import type { ProviderConfig } from "../../env";
import { extractItemTexts } from "../registry";
import { ModelTrait } from "../types";
import type {
	AIProvider,
	ConversationItem,
	ModelInfo,
	ModelRequest,
	ModelResponse,
	ProviderItem,
	StreamEvent,
	ToolCall,
	ToolDefinition
} from "../types";

const {
	Thinking,
	FunctionCalling,
	WebSearch,
	ViewImage,
	ReadDocument,
	GenerateImage
} = ModelTrait;

/** Traits shared by every model here: they all take tools and read documents. */
const COMMON: readonly ModelTrait[] = [FunctionCalling, ViewImage, ReadDocument];

/**
 * Model catalogue, in the order it is offered to users.
 *
 * Thinking membership deliberately mirrors the historical
 * `/^o\d/ || /^gpt-5(\.|$)/` test — note that `gpt-5-mini` and `gpt-5-nano` are
 * excluded by it, which is why they carry no Thinking trait.
 */
const CATALOGUE: readonly { id: string; traits: readonly ModelTrait[] }[] = [
	{ id: "gpt-5.6-sol", traits: [...COMMON, Thinking, WebSearch, GenerateImage] },
	{ id: "gpt-5.6-terra", traits: [...COMMON, Thinking, WebSearch, GenerateImage] },
	{ id: "gpt-5.6-luna", traits: [...COMMON, Thinking, WebSearch, GenerateImage] },
	{ id: "gpt-5.4", traits: [...COMMON, Thinking, WebSearch, GenerateImage] },
	{ id: "gpt-5.4-mini", traits: [...COMMON, Thinking] },
	{ id: "gpt-5.4-nano", traits: [...COMMON, Thinking] },
	{ id: "gpt-5.2-pro", traits: [...COMMON, Thinking] },
	{ id: "gpt-5.2", traits: [...COMMON, Thinking, WebSearch, GenerateImage] },
	{ id: "gpt-5.1", traits: [...COMMON, Thinking, WebSearch, GenerateImage] },
	{ id: "gpt-5", traits: [...COMMON, Thinking, WebSearch, GenerateImage] },
	{ id: "gpt-5-mini", traits: [...COMMON, WebSearch] },
	{ id: "gpt-5-nano", traits: [...COMMON, GenerateImage] },
	{ id: "o1-pro", traits: [...COMMON, Thinking] },
	{ id: "gpt-4.1", traits: [...COMMON, WebSearch] },
	{ id: "gpt-4.1-mini", traits: [...COMMON, WebSearch] },
	{ id: "gpt-4.1-nano", traits: [...COMMON] },
	{ id: "o4-mini", traits: [...COMMON, Thinking] },
	{ id: "o3", traits: [...COMMON, Thinking] },
	// o3-mini is text-only.
	{ id: "o3-mini", traits: [FunctionCalling, Thinking] },
	{ id: "o1", traits: [...COMMON, Thinking] },
	{ id: "gpt-4o", traits: [...COMMON, WebSearch] },
	{ id: "gpt-4o-mini", traits: [...COMMON, WebSearch] },
	{ id: "gpt-4-turbo", traits: [...COMMON] }
];

/**
 * OpenAI provider, backed by the Responses API.
 *
 * Provider-native history items (assistant messages, reasoning items,
 * function calls) are stored opaquely and passed back verbatim, so the wire
 * format is exactly the same as talking to the Responses API directly.
 */
export class OpenAIProvider implements AIProvider {
	readonly id = "openai";
	readonly models: readonly ModelInfo[] = CATALOGUE.map((entry) => ({
		id: entry.id,
		// OpenAI model IDs are already the name people know them by.
		displayName: entry.id,
		provider: "openai",
		traits: entry.traits
	}));

	private client: OpenAI;

	constructor(config: ProviderConfig) {
		// Optional settings are only forwarded when set, so the SDK keeps its own
		// defaults (and its process.env fallbacks) otherwise.
		this.client = new OpenAI({
			apiKey: config.API_KEY,
			...(config.BASE_URL ? { baseURL: config.BASE_URL } : {}),
			...(config.ORGANIZATION ? { organization: config.ORGANIZATION } : {}),
			...(config.PROJECT ? { project: config.PROJECT } : {})
		});
	}

	getModelInfo(model: string): ModelInfo {
		const known = this.models.find((entry) => entry.id === model);
		if (known)
			return known;

		// Not catalogued (a hand-written MODEL_DEFAULT, or a model released
		// after this list): infer thinking from the naming scheme, exactly as
		// the pre-trait implementation did.
		const traits: ModelTrait[] = [ModelTrait.FunctionCalling];
		if (/^o\d/.test(model) || /^gpt-5(\.|$)/.test(model))
			traits.push(ModelTrait.Thinking);

		return { id: model, displayName: model, provider: this.id, traits };
	}

	hasTrait(model: string, trait: ModelTrait): boolean {
		return this.getModelInfo(model).traits.includes(trait);
	}

	/** Returns null for items that carry nothing this provider can send. */
	private serializeItem(item: ConversationItem): Record<string, any> | null {
		switch (item.kind) {
			case "message":
				return {
					role: item.role,
					content: item.content.map((part) => {
						if (part.type === "image") {
							return {
								type: "input_image",
								image_url: part.url
							};
						}

						return {
							type: "input_text",
							text: part.text
						};
					})
				};

			case "provider": {
				if (item.provider === this.id)
					return item.item;

				// History from another provider: keep the text, drop the
				// provider-specific structure the Responses API would reject.
				const text = extractItemTexts(item).join("\n").trim();
				if (!text)
					return null;

				return {
					role: "assistant",
					content: [{ type: "output_text", text }]
				};
			}

			case "tool_result":
				return {
					type: "function_call_output",
					call_id: item.callId,
					output: item.output
				};
		}
	}

	private serializeTools(request: ModelRequest): Record<string, any>[] {
		const tools: Record<string, any>[] = [];

		if (request.enableWebSearch && this.hasTrait(request.model, ModelTrait.WebSearch))
			tools.push({ type: "web_search_preview" });

		if (request.enableImageGeneration && this.hasTrait(request.model, ModelTrait.GenerateImage))
			tools.push({ type: "image_generation" });

		for (const tool of request.tools) {
			tools.push({
				type: "function",
				name: tool.name,
				description: tool.description,
				strict: tool.strict ?? true,
				parameters: tool.parameters
			});
		}

		return tools;
	}

	private buildPayload(request: ModelRequest): Record<string, any> {
		const payload: Record<string, any> = {
			model: request.model,
			instructions: request.instructions,
			input: request.input
				.map((item) => this.serializeItem(item))
				.filter((item): item is Record<string, any> => item !== null),
			tools: this.serializeTools(request)
		};

		if (request.reasoningEffort && this.hasTrait(request.model, ModelTrait.Thinking)) {
			payload.reasoning = {
				effort: request.reasoningEffort || "medium",
				summary: "auto"
			};
		}

		return payload;
	}

	private toProviderItems(output: Record<string, any>[]): ProviderItem[] {
		return output.map((item) => ({
			kind: "provider",
			provider: this.id,
			item
		}));
	}

	private extractOutputText(output: Record<string, any>[]): string {
		const texts: string[] = [];

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

	private extractToolCalls(output: Record<string, any>[]): ToolCall[] {
		return output
			.filter((item) => item?.type === "function_call")
			.map((item) => ({
				id: item.call_id,
				name: item.name,
				arguments: item.arguments || ""
			}));
	}

	private toModelResponse(response: Record<string, any> | null, accumulatedToolCalls?: Record<string, any>[]): ModelResponse {
		const output: Record<string, any>[] = response?.output || [];
		const toolCalls = accumulatedToolCalls
			? accumulatedToolCalls.map((item) => ({
				id: item.call_id,
				name: item.name,
				arguments: item.arguments || ""
			}))
			: this.extractToolCalls(output);

		return {
			items: this.toProviderItems(output),
			outputText: response?.output_text || this.extractOutputText(output),
			toolCalls
		};
	}

	async respond(request: ModelRequest): Promise<ModelResponse> {
		const response = await (this.client.responses.create as any)(this.buildPayload(request));
		return this.toModelResponse(response);
	}

	async *stream(request: ModelRequest): AsyncGenerator<StreamEvent> {
		const stream = await (this.client.responses.create as any)({
			...this.buildPayload(request),
			stream: true
		});

		const toolCalls: Record<number, Record<string, any>> = {};
		let finalResponse: Record<string, any> | null = null;

		for await (const event of stream as AsyncIterable<Record<string, any>>) {
			const { type } = event;

			switch (type) {
				case "response.reasoning_summary_text.delta": {
					yield { type: "reasoning_delta", delta: event.delta };
					break;
				}

				case "response.reasoning_summary_part.added": {
					yield { type: "reasoning_part_added" };
					break;
				}

				case "response.output_text.delta": {
					yield { type: "text_delta", delta: event.delta };
					break;
				}

				case "response.output_item.added": {
					if (event.item?.type === "function_call") {
						toolCalls[event.output_index] = {
							...event.item,
							arguments: event.item.arguments || ""
						};

						yield {
							type: "tool_call_added",
							callId: event.item.call_id || null,
							name: event.item.name
						};
					}
					break;
				}

				case "response.function_call_arguments.delta": {
					const current = toolCalls[event.output_index];
					if (current)
						current.arguments += event.delta || "";

					break;
				}

				case "response.function_call_arguments.done": {
					const current = toolCalls[event.output_index];
					if (current && event.arguments)
						current.arguments = event.arguments;

					break;
				}

				case "response.image_generation_call.in_progress": {
					yield { type: "image_in_progress", index: event.output_index };
					break;
				}

				case "response.image_generation_call.generating": {
					yield { type: "image_generating", index: event.output_index };
					break;
				}

				case "response.image_generation_call.partial_image": {
					yield {
						type: "image_partial",
						index: event.output_index,
						imageBase64: event.partial_image_b64,
						format: event.output_format,
						size: event.size
					};
					break;
				}

				case "response.output_item.done": {
					if (event.item.type == "image_generation_call") {
						yield {
							type: "image_completed",
							index: event.output_index,
							imageBase64: event.item.result,
							format: event.item.output_format,
							size: event.item.size,
							revisedPrompt: event.item.revised_prompt
						};
					}

					break;
				}

				case "response.completed": {
					finalResponse = event.response;
					break;
				}

				default:
					break;
			}
		}

		yield {
			type: "completed",
			response: this.toModelResponse(finalResponse, Object.values(toolCalls))
		};
	}

	async generateText({ model, instructions, input }: { model: string; instructions: string; input: string }): Promise<string> {
		const response = await this.client.responses.create({
			model,
			instructions,
			input
		});

		return (response.output_text || this.extractOutputText((response.output as Record<string, any>[]) || []) || "").trim();
	}

	extractTexts(item: ProviderItem): string[] {
		const texts: string[] = [];
		const raw = item.item;

		if (!raw)
			return texts;

		const content = raw.content;
		if (Array.isArray(content)) {
			for (const part of content) {
				if (part?.type === "input_text" && typeof part.text === "string")
					texts.push(part.text);
				if (part?.type === "output_text" && typeof part.text === "string")
					texts.push(part.text);
			}
		} else if (typeof content === "string") {
			texts.push(content);
		}

		return texts;
	}
}
