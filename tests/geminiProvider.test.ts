import { describe, expect, test } from "bun:test";
import { GeminiProvider } from "../src/ai/providers/gemini";
import { registerProvider } from "../src/ai/registry";
import { ModelTrait, type AIProvider, type ConversationItem, type ModelRequest, type ProviderItem, type StreamEvent, type ToolDefinition } from "../src/ai/types";

const provider = new GeminiProvider({ API_KEY: "test-key" });

const buildRequest = (request: ModelRequest) => (provider as any).buildRequest(request) as Promise<Record<string, any>>;

function req(overrides: Partial<ModelRequest> = {}): ModelRequest {
	return {
		model: "gemini-3.6-flash",
		instructions: "be terse",
		input: [],
		tools: [],
		...overrides
	};
}

const userMsg = (text: string): ConversationItem => ({ kind: "message", role: "user", content: [{ type: "text", text }] });

/**
 * A tool shaped like the real ones: strict, every property required, and
 * nullability expressed as a JSON-Schema type union.
 */
const TOOL: ToolDefinition = {
	name: "get_weather",
	description: "Get the weather.",
	strict: true,
	parameters: {
		type: "object",
		properties: {
			city: { type: "string", description: "City name." },
			unit: { type: ["string", "null"], enum: ["c", "f"], description: "Unit or null." },
			days: { type: ["number", "null"], description: "Day count or null." },
			tags: { type: "array", items: { type: "string" }, description: "Tags." }
		},
		required: ["city", "unit", "days", "tags"],
		additionalProperties: false
	}
};

describe("schema translation", () => {
	test("union types become a single type plus nullable, and extras are dropped", async () => {
		const payload = await buildRequest(req({ tools: [TOOL] }));
		const declaration = payload.config.tools[0].functionDeclarations[0];

		expect(declaration.name).toBe("get_weather");
		expect(declaration.description).toBe("Get the weather.");
		expect(declaration.parameters).toEqual({
			type: "OBJECT",
			required: ["city", "unit", "days", "tags"],
			properties: {
				city: { type: "STRING", description: "City name." },
				unit: { type: "STRING", nullable: true, description: "Unit or null.", enum: ["c", "f"] },
				days: { type: "NUMBER", nullable: true, description: "Day count or null." },
				tags: { type: "ARRAY", description: "Tags.", items: { type: "STRING" } }
			}
		});

		// Gemini rejects these OpenAI-only keys.
		expect(JSON.stringify(declaration)).not.toContain("additionalProperties");
		expect(JSON.stringify(declaration)).not.toContain("strict");
	});

	test("google search is only added when no function tools are present", async () => {
		const withTools = await buildRequest(req({ tools: [TOOL], enableWebSearch: true }));
		expect(JSON.stringify(withTools.config.tools)).not.toContain("googleSearch");

		const withoutTools = await buildRequest(req({ enableWebSearch: true }));
		expect(withoutTools.config.tools).toEqual([{ googleSearch: {} }]);
	});

	test("web search is not offered on image-output models", async () => {
		const payload = await buildRequest(req({ model: "gemini-3-pro-image", enableWebSearch: true }));
		expect(payload.config.tools).toBeUndefined();
	});
});

describe("request assembly", () => {
	test("instructions become systemInstruction", async () => {
		const payload = await buildRequest(req({ instructions: "you are a bot" }));
		expect(payload.config.systemInstruction).toBe("you are a bot");
	});

	test("roles map onto Gemini's user/model pair", async () => {
		const payload = await buildRequest(req({
			input: [
				userMsg("hello"),
				{ kind: "message", role: "developer", content: [{ type: "text", text: "context note" }] },
				{ kind: "message", role: "assistant", content: [{ type: "text", text: "prior reply" }] }
			]
		}));

		expect(payload.contents).toEqual([
			{ role: "user", parts: [{ text: "hello" }] },
			{ role: "user", parts: [{ text: "context note" }] },
			{ role: "model", parts: [{ text: "prior reply" }] }
		]);
	});

	test("own provider items are replayed verbatim, keeping thought signatures", async () => {
		const raw = {
			role: "model",
			parts: [
				{ text: "thinking", thought: true, thoughtSignature: "sig-123" },
				{ functionCall: { id: "call_1", name: "get_weather", args: { city: "Hanoi" } } }
			]
		};

		const payload = await buildRequest(req({
			input: [{ kind: "provider", provider: "gemini", item: raw }]
		}));

		expect(payload.contents[0]).toBe(raw);
	});

	test("tool results become functionResponse with the call's function name", async () => {
		const payload = await buildRequest(req({
			input: [
				userMsg("weather?"),
				{
					kind: "provider",
					provider: "gemini",
					item: { role: "model", parts: [{ functionCall: { id: "call_9", name: "get_weather", args: {} } }] }
				},
				{ kind: "tool_result", callId: "call_9", output: JSON.stringify({ ok: true, tempC: 31 }) }
			]
		}));

		expect(payload.contents[2]).toEqual({
			role: "user",
			parts: [{
				functionResponse: {
					id: "call_9",
					name: "get_weather",
					response: { ok: true, tempC: 31 }
				}
			}]
		});
	});

	test("synthesized call IDs resolve the name without sending a bogus id", async () => {
		const payload = await buildRequest(req({
			input: [{ kind: "tool_result", callId: "get_weather#0", output: "{\"ok\":true}" }]
		}));

		expect(payload.contents[0].parts[0].functionResponse).toEqual({
			name: "get_weather",
			response: { ok: true }
		});
	});

	test("non-JSON tool output is still delivered", async () => {
		const payload = await buildRequest(req({
			input: [{ kind: "tool_result", callId: "x#0", output: "not json" }]
		}));

		expect(payload.contents[0].parts[0].functionResponse.response).toEqual({ output: "not json" });
	});

	test("image models request image output", async () => {
		const payload = await buildRequest(req({ model: "gemini-3-pro-image" }));
		expect(payload.config.responseModalities).toEqual(["TEXT", "IMAGE"]);
	});
});

describe("thinking configuration", () => {
	test("modern models use thinkingLevel", async () => {
		const payload = await buildRequest(req({ model: "gemini-3.6-flash", reasoningEffort: "high" }));
		expect(payload.config.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "HIGH" });
	});

	test("unversioned aliases also use thinkingLevel", async () => {
		const payload = await buildRequest(req({ model: "gemini-flash-latest", reasoningEffort: "minimal" }));
		expect(payload.config.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "MINIMAL" });
	});

	test("the 2.5 family falls back to the numeric budget", async () => {
		const payload = await buildRequest(req({ model: "gemini-2.5-flash", reasoningEffort: "medium" }));
		expect(payload.config.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: -1 });
	});

	test("no effort means no thinking config", async () => {
		const payload = await buildRequest(req({ model: "gemini-3.6-flash" }));
		expect(payload.config.thinkingConfig).toBeUndefined();
	});
});

describe("cross-provider history", () => {
	test("items from another provider are downconverted to text", async () => {
		const info = { id: "stub-model", displayName: "stub-model", provider: "stub-provider", traits: [] };
		const foreign: AIProvider = {
			id: "stub-provider",
			models: [info],
			getModelInfo: () => info,
			hasTrait: () => false,
			respond: async () => ({ items: [], outputText: "", toolCalls: [] }),
			stream: (async function* () { })() as any,
			generateText: async () => "",
			extractTexts: () => ["carried over text"]
		};

		registerProvider(foreign);

		const payload = await buildRequest(req({
			input: [{ kind: "provider", provider: "stub-provider", item: { anything: true } }]
		}));

		expect(payload.contents).toEqual([{ role: "model", parts: [{ text: "carried over text" }] }]);
	});

	test("foreign items with no extractable text are dropped", async () => {
		const payload = await buildRequest(req({
			input: [
				{ kind: "provider", provider: "not-registered", item: { junk: 1 } },
				userMsg("still here")
			]
		}));

		expect(payload.contents).toEqual([{ role: "user", parts: [{ text: "still here" }] }]);
	});
});

describe("streaming", () => {
	async function collect(chunks: Record<string, any>[]): Promise<StreamEvent[]> {
		const streaming = new GeminiProvider({ API_KEY: "test-key" });

		(streaming as any).client = {
			models: {
				generateContentStream: async () => (async function* () {
					for (const chunk of chunks)
						yield chunk;
				})()
			}
		};

		const events: StreamEvent[] = [];
		for await (const event of streaming.stream(req()))
			events.push(event);

		return events;
	}

	const chunk = (parts: Record<string, any>[]) => ({ candidates: [{ content: { parts } }] });

	test("thought parts stream as reasoning, plain text as output", async () => {
		const events = await collect([
			chunk([{ text: "let me think", thought: true }]),
			chunk([{ text: "Hello " }]),
			chunk([{ text: "world" }])
		]);

		expect(events.map((e) => e.type)).toEqual(["reasoning_delta", "text_delta", "text_delta", "completed"]);

		const completed = events.at(-1) as Extract<StreamEvent, { type: "completed" }>;
		// Thought text is excluded from the reply body.
		expect(completed.response.outputText).toBe("Hello world");
	});

	test("function calls emit an event whose ID matches the final response", async () => {
		const events = await collect([
			chunk([{ functionCall: { name: "get_weather", args: { city: "Hanoi" } } }])
		]);

		const added = events.find((e) => e.type === "tool_call_added") as Extract<StreamEvent, { type: "tool_call_added" }>;
		const completed = events.at(-1) as Extract<StreamEvent, { type: "completed" }>;

		expect(added.name).toBe("get_weather");
		expect(completed.response.toolCalls).toEqual([
			{ id: added.callId!, name: "get_weather", arguments: "{\"city\":\"Hanoi\"}" }
		]);
	});

	test("parallel function calls get distinct synthesized IDs", async () => {
		const events = await collect([
			chunk([
				{ functionCall: { name: "get_weather", args: { city: "A" } } },
				{ functionCall: { name: "get_weather", args: { city: "B" } } }
			])
		]);

		const completed = events.at(-1) as Extract<StreamEvent, { type: "completed" }>;
		const ids = completed.response.toolCalls.map((c) => c.id);

		expect(new Set(ids).size).toBe(2);
		expect(events.filter((e) => e.type === "tool_call_added").map((e: any) => e.callId)).toEqual(ids);
	});

	test("inline images open a placeholder slot then complete it", async () => {
		const events = await collect([
			chunk([{ inlineData: { mimeType: "image/png", data: "QUJD" } }])
		]);

		expect(events.slice(0, 2)).toEqual([
			{ type: "image_in_progress", index: 0 },
			{ type: "image_completed", index: 0, imageBase64: "QUJD", format: "png" }
		]);
	});

	test("the accumulated turn is stored as one replayable provider item", async () => {
		const events = await collect([
			chunk([{ text: "part one " }]),
			chunk([{ text: "part two" }])
		]);

		const completed = events.at(-1) as Extract<StreamEvent, { type: "completed" }>;
		const item = completed.response.items[0] as ProviderItem;

		expect(item.kind).toBe("provider");
		expect(item.provider).toBe("gemini");
		expect((item.item as any).role).toBe("model");
		expect((item.item as any).parts).toHaveLength(2);
	});
});

describe("model traits", () => {
	test("chat models are multimodal in, with thinking and search", () => {
		const traits = provider.getModelInfo("gemini-3.6-flash").traits;

		expect(traits).toContain(ModelTrait.Thinking);
		expect(traits).toContain(ModelTrait.FunctionCalling);
		expect(traits).toContain(ModelTrait.WebSearch);
		expect(traits).toContain(ModelTrait.ViewImage);
		expect(traits).toContain(ModelTrait.ViewVideo);
		expect(traits).toContain(ModelTrait.AnalyzeAudio);
		expect(traits).toContain(ModelTrait.ReadDocument);
		expect(traits).not.toContain(ModelTrait.GenerateImage);
	});

	test("image models generate images but take no tools or search", () => {
		const traits = provider.getModelInfo("gemini-3-pro-image").traits;

		expect(traits).toContain(ModelTrait.GenerateImage);
		expect(traits).not.toContain(ModelTrait.FunctionCalling);
		expect(traits).not.toContain(ModelTrait.WebSearch);
	});

	test("every catalogued model carries a display name and its provider", () => {
		for (const model of provider.models) {
			expect(model.provider).toBe("gemini");
			expect(model.displayName.length).toBeGreaterThan(0);
			expect(model.traits.length).toBeGreaterThan(0);
		}
	});

	test("uncatalogued models infer traits from their name", () => {
		expect(provider.hasTrait("gemini-9.9-flash", ModelTrait.Thinking)).toBe(true);
		expect(provider.hasTrait("gemini-9.9-flash", ModelTrait.GenerateImage)).toBe(false);
		expect(provider.hasTrait("gemini-9.9-flash-image", ModelTrait.GenerateImage)).toBe(true);
	});

	test("retired 2.5 models are not offered", () => {
		expect(provider.models.some((model) => model.id.startsWith("gemini-2.5"))).toBe(false);
	});
});

describe("trait-driven request shaping", () => {
	test("image models get no function declarations even when tools are passed", async () => {
		// The bot always offers its 22 tools; Gemini's image models reject them.
		const payload = await buildRequest(req({ model: "gemini-3-pro-image", tools: [TOOL] }));

		expect(payload.config.tools).toBeUndefined();
		expect(payload.config.responseModalities).toEqual(["TEXT", "IMAGE"]);
	});

	test("chat models still receive the declarations", async () => {
		const payload = await buildRequest(req({ model: "gemini-3.6-flash", tools: [TOOL] }));
		expect(payload.config.tools[0].functionDeclarations).toHaveLength(1);
	});
});

describe("text extraction", () => {
	test("thought parts are excluded from extracted text", () => {
		const texts = provider.extractTexts({
			kind: "provider",
			provider: "gemini",
			item: {
				role: "model",
				parts: [
					{ text: "hidden reasoning", thought: true },
					{ text: "visible answer" }
				]
			}
		});

		expect(texts).toEqual(["visible answer"]);
	});

	test("malformed items extract nothing", () => {
		expect(provider.extractTexts({ kind: "provider", provider: "gemini", item: {} })).toEqual([]);
	});
});
