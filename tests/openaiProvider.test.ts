import { describe, expect, test } from "bun:test";
import { OpenAIProvider } from "../src/ai/providers/openai";
import type { ModelRequest, StreamEvent } from "../src/ai/types";

const provider = new OpenAIProvider("test-key");

// Private methods are exercised directly: they define the OpenAI wire format,
// which must stay byte-compatible with the pre-refactor payloads.
const buildPayload = (request: ModelRequest) => (provider as any).buildPayload(request);

function baseRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
	return {
		model: "gpt-4o",
		instructions: "be helpful",
		input: [],
		tools: [],
		...overrides
	};
}

describe("OpenAI wire serialization", () => {
	test("user message parts serialize to input_text / input_image", () => {
		const payload = buildPayload(baseRequest({
			input: [{
				kind: "message",
				role: "user",
				content: [
					{ type: "text", text: "hello" },
					{ type: "image", url: "https://img.example/a.png" }
				]
			}]
		}));

		expect(payload.input).toEqual([{
			role: "user",
			content: [
				{ type: "input_text", text: "hello" },
				{ type: "input_image", image_url: "https://img.example/a.png" }
			]
		}]);
	});

	test("developer messages keep the developer role", () => {
		const payload = buildPayload(baseRequest({
			input: [{
				kind: "message",
				role: "developer",
				content: [{ type: "text", text: "Memory summary:\n- a fact" }]
			}]
		}));

		expect(payload.input[0].role).toBe("developer");
	});

	test("provider-native items are passed back verbatim (reasoning round-trip)", () => {
		const rawReasoning = {
			type: "reasoning",
			id: "rs_123",
			summary: [{ type: "summary_text", text: "thinking..." }]
		};
		const rawFunctionCall = {
			type: "function_call",
			call_id: "call_1",
			name: "get_user_info",
			arguments: "{\"userId\":\"1\"}"
		};

		const payload = buildPayload(baseRequest({
			input: [
				{ kind: "provider", provider: "openai", item: rawReasoning },
				{ kind: "provider", provider: "openai", item: rawFunctionCall }
			]
		}));

		// Same object references — nothing added, dropped, or cloned.
		expect(payload.input[0]).toBe(rawReasoning);
		expect(payload.input[1]).toBe(rawFunctionCall);
	});

	test("tool results serialize to function_call_output with the frozen JSON string", () => {
		const output = JSON.stringify({ ok: true, value: 42 });
		const payload = buildPayload(baseRequest({
			input: [{ kind: "tool_result", callId: "call_9", output }]
		}));

		expect(payload.input).toEqual([{
			type: "function_call_output",
			call_id: "call_9",
			output
		}]);
	});

	test("function tools keep the Responses envelope with strict defaulting to true", () => {
		const parameters = {
			type: "object",
			properties: { url: { type: "string", description: "target" } },
			required: ["url"],
			additionalProperties: false
		};

		const payload = buildPayload(baseRequest({
			tools: [{ name: "fetch_webpage", description: "Fetch a webpage.", parameters }]
		}));

		expect(payload.tools).toEqual([{
			type: "function",
			name: "fetch_webpage",
			description: "Fetch a webpage.",
			strict: true,
			parameters
		}]);
		// parameters passed by reference, not restructured
		expect(payload.tools[0].parameters).toBe(parameters);
	});

	test("builtin tools are placed before function tools, in web_search → image_generation order", () => {
		const payload = buildPayload(baseRequest({
			model: "gpt-5",
			enableWebSearch: true,
			enableImageGeneration: true,
			tools: [{ name: "a_tool", description: "d", parameters: {} }]
		}));

		expect(payload.tools.map((t: any) => t.type)).toEqual([
			"web_search_preview",
			"image_generation",
			"function"
		]);
	});

	test("builtin tools are omitted for models that do not support them", () => {
		// gpt-4-turbo is in neither support list.
		const payload = buildPayload(baseRequest({
			model: "gpt-4-turbo",
			enableWebSearch: true,
			enableImageGeneration: true
		}));

		expect(payload.tools).toEqual([]);
	});
});

describe("reasoning parameter gating", () => {
	test("reasoning models get { effort, summary: 'auto' }", () => {
		const payload = buildPayload(baseRequest({ model: "gpt-5.4", reasoningEffort: "high" }));
		expect(payload.reasoning).toEqual({ effort: "high", summary: "auto" });
	});

	test("o-series models count as reasoning models", () => {
		const payload = buildPayload(baseRequest({ model: "o3-mini", reasoningEffort: "low" }));
		expect(payload.reasoning).toEqual({ effort: "low", summary: "auto" });
	});

	test("unknown model ids still match by regex (gpt-5.x)", () => {
		const payload = buildPayload(baseRequest({ model: "gpt-5.9-unlisted", reasoningEffort: "medium" }));
		expect(payload.reasoning).toEqual({ effort: "medium", summary: "auto" });
	});

	test("non-reasoning models never get a reasoning param", () => {
		const payload = buildPayload(baseRequest({ model: "gpt-4o", reasoningEffort: "high" }));
		expect(payload.reasoning).toBeUndefined();
	});

	test("no reasoningEffort means no reasoning param, even on reasoning models", () => {
		const payload = buildPayload(baseRequest({ model: "gpt-5" }));
		expect(payload.reasoning).toBeUndefined();
	});
});

describe("model capabilities", () => {
	test("model catalogue stays within Discord's 25-choice limit", () => {
		expect(provider.models.length).toBeLessThanOrEqual(25);
	});

	test("capability checks match the catalogue", () => {
		expect(provider.supportsWebSearch("gpt-4o")).toBe(true);
		expect(provider.supportsWebSearch("o3")).toBe(false);
		expect(provider.supportsImageGeneration("gpt-5-nano")).toBe(true);
		expect(provider.supportsImageGeneration("gpt-4o")).toBe(false);
		expect(provider.isReasoningModel("o1-pro")).toBe(true);
		expect(provider.isReasoningModel("gpt-4.1")).toBe(false);
	});
});

describe("streaming event normalization", () => {
	async function collectEvents(sourceEvents: Record<string, any>[]): Promise<StreamEvent[]> {
		const streaming = new OpenAIProvider("test-key");

		// Stub the SDK call: stream() must translate each source event 1:1, in order.
		(streaming as any).client = {
			responses: {
				create: async () => (async function* () {
					for (const event of sourceEvents)
						yield event;
				})()
			}
		};

		const events: StreamEvent[] = [];
		for await (const event of streaming.stream(baseRequest({ model: "gpt-5" })))
			events.push(event);

		return events;
	}

	test("full stream translates 1:1 in order and accumulates tool calls", async () => {
		const finalResponse = {
			output_text: "final text",
			output: [
				{ type: "reasoning", id: "rs_1" },
				{ type: "function_call", call_id: "call_1", name: "get_user_info", arguments: "{\"userId\":\"7\"}" }
			]
		};

		const events = await collectEvents([
			{ type: "response.reasoning_summary_part.added" },
			{ type: "response.reasoning_summary_text.delta", delta: "thin" },
			{ type: "response.reasoning_summary_text.delta", delta: "king" },
			{ type: "response.output_item.added", output_index: 1, item: { type: "function_call", call_id: "call_1", name: "get_user_info" } },
			{ type: "response.function_call_arguments.delta", output_index: 1, delta: "{\"userId\"" },
			{ type: "response.function_call_arguments.delta", output_index: 1, delta: ":\"7\"}" },
			{ type: "response.function_call_arguments.done", output_index: 1, arguments: "{\"userId\":\"7\"}" },
			{ type: "response.output_text.delta", delta: "hello" },
			{ type: "response.some_unknown_event" },
			{ type: "response.completed", response: finalResponse }
		]);

		expect(events.map((e) => e.type)).toEqual([
			"reasoning_part_added",
			"reasoning_delta",
			"reasoning_delta",
			"tool_call_added",
			"text_delta",
			"completed"
		]);

		const completed = events.at(-1) as Extract<StreamEvent, { type: "completed" }>;
		expect(completed.response.outputText).toBe("final text");
		expect(completed.response.toolCalls).toEqual([
			{ id: "call_1", name: "get_user_info", arguments: "{\"userId\":\"7\"}" }
		]);
		// History items wrap the raw output verbatim.
		expect(completed.response.items.map((i: any) => i.item)).toEqual(finalResponse.output);
	});

	test("image generation events carry index, payload, and revised prompt", async () => {
		const events = await collectEvents([
			{ type: "response.image_generation_call.in_progress", output_index: 0 },
			{ type: "response.image_generation_call.generating", output_index: 0 },
			{ type: "response.image_generation_call.partial_image", output_index: 0, partial_image_b64: "AAA", output_format: "png", size: "1024x1024" },
			{ type: "response.output_item.done", output_index: 0, item: { type: "image_generation_call", result: "BBB", output_format: "png", size: "1024x1024", revised_prompt: "a cat" } },
			{ type: "response.completed", response: { output_text: "", output: [] } }
		]);

		expect(events).toEqual([
			{ type: "image_in_progress", index: 0 },
			{ type: "image_generating", index: 0 },
			{ type: "image_partial", index: 0, imageBase64: "AAA", format: "png", size: "1024x1024" },
			{ type: "image_completed", index: 0, imageBase64: "BBB", format: "png", size: "1024x1024", revisedPrompt: "a cat" },
			{ type: "completed", response: { items: [], outputText: "", toolCalls: [] } }
		]);
	});

	test("output_text extraction falls back to concatenating message items", async () => {
		const events = await collectEvents([
			{
				type: "response.completed",
				response: {
					output: [
						{ type: "message", content: [{ type: "output_text", text: "part one" }] },
						{ type: "message", content: [{ type: "output_text", text: "part two" }] }
					]
				}
			}
		]);

		const completed = events.at(-1) as Extract<StreamEvent, { type: "completed" }>;
		expect(completed.response.outputText).toBe("part one\npart two");
	});
});
