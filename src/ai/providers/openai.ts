import OpenAI from "openai";
import { env } from "../../env";
import type {
	AIProvider,
	ConversationItem,
	ModelRequest,
	ModelResponse,
	ProviderItem,
	StreamEvent,
	ToolCall,
	ToolDefinition
} from "../types";

// Discord limits a slash command option to 25 choices, and this list is fed
// straight into `/model` via addChoices, so it must stay at or under 25.
const MODELS = [
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.4-nano",
	"gpt-5.2-pro",
	"gpt-5.2",
	"gpt-5.1",
	"gpt-5",
	"gpt-5-mini",
	"gpt-5-nano",
	"o1-pro",
	"gpt-4.1",
	"gpt-4.1-mini",
	"gpt-4.1-nano",
	"o4-mini",
	"o3",
	"o3-mini",
	"o1",
	"gpt-4o",
	"gpt-4o-mini",
	"gpt-4-turbo"
];

const SUPPORT_SEARCH = [
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-5.4",
	"gpt-5.2",
	"gpt-5.1",
	"gpt-5",
	"gpt-5-mini",
	"gpt-4.1",
	"gpt-4.1-mini",
	"gpt-4o",
	"gpt-4o-mini"
];

const SUPPORT_IMAGE_GENERATION = [
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-5.4",
	"gpt-5.2",
	"gpt-5.1",
	"gpt-5",
	"gpt-5-nano"
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
	readonly models = MODELS;

	private client: OpenAI;

	constructor(apiKey: string = env.OPENAI_API_KEY) {
		this.client = new OpenAI({ apiKey });
	}

	isReasoningModel(model: string): boolean {
		return (/^o\d/.test(model) || /^gpt-5(\.|$)/.test(model));
	}

	supportsWebSearch(model: string): boolean {
		return SUPPORT_SEARCH.includes(model);
	}

	supportsImageGeneration(model: string): boolean {
		return SUPPORT_IMAGE_GENERATION.includes(model);
	}

	private serializeItem(item: ConversationItem): Record<string, any> {
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

			case "provider":
				return item.item;

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

		if (request.enableWebSearch && this.supportsWebSearch(request.model))
			tools.push({ type: "web_search_preview" });

		if (request.enableImageGeneration && this.supportsImageGeneration(request.model))
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
			input: request.input.map((item) => this.serializeItem(item)),
			tools: this.serializeTools(request)
		};

		if (request.reasoningEffort && this.isReasoningModel(request.model)) {
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

export const openAIProvider = new OpenAIProvider();
