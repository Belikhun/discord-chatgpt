import { describe, expect, test } from "bun:test";
import { runToolLoop } from "../src/conversation/toolLoop";
import { runToolCalls } from "../src/tools/registry";
import type { ConversationItem, ModelRequest, ModelResponse } from "../src/ai/types";
import type { Tool } from "../src/tools/types";

function callResponse(...names: string[]): ModelResponse {
	return {
		items: names.map((name, index) => ({ kind: "provider", provider: "stub", item: { type: "function_call", name, call_id: `${name}-${index}` } })),
		outputText: "",
		toolCalls: names.map((name, index) => ({ id: `${name}-${index}`, name, arguments: "{}" }))
	};
}

function textResponse(text: string): ModelResponse {
	return { items: [{ kind: "provider", provider: "stub", item: { type: "message", text } }], outputText: text, toolCalls: [] };
}

function tool(name: string, run: () => Promise<Record<string, any>>, timeoutMs?: number): Tool {
	return {
		definition: { name, description: name, parameters: { type: "object", properties: {} } },
		execute: run,
		timeoutMs
	};
}

const baseRequest: ModelRequest = { model: "stub", instructions: "", input: [], tools: [{ name: "slow", description: "", parameters: {} }] };

describe("tool loop", () => {
	test("returns the first answer that asks for no tools", async () => {
		const history: ConversationItem[] = [];
		const responses = [callResponse("missing"), textResponse("done")];

		const result = await runToolLoop({
			request: baseRequest,
			context: {},
			maxPasses: 5,
			call: async () => responses.shift()!,
			onItems: (items) => history.push(...items)
		});

		expect(result.response?.outputText).toBe("done");
		expect(result.passes).toBe(2);
		expect(result.exhausted).toBe(false);
		// call item, its result, then the answer
		expect(history.map((item) => item.kind)).toEqual(["provider", "tool_result", "provider"]);
	});

	test("the last pass is sent without tools and every call still gets an output", async () => {
		const seenTools: number[] = [];
		const history: ConversationItem[] = [];

		const result = await runToolLoop({
			request: baseRequest,
			context: {},
			maxPasses: 3,
			call: async (request) => {
				seenTools.push(request.tools.length);
				return callResponse("missing");
			},
			onItems: (items) => history.push(...items)
		});

		expect(seenTools).toEqual([1, 1, 0]);
		expect(result.exhausted).toBe(true);

		const calls = history.filter((item) => item.kind === "provider").length;
		const outputs = history.filter((item) => item.kind === "tool_result").length;
		expect(outputs).toBe(calls);
	});

	test("tool calls run concurrently and a slow one times out without blocking the rest", async () => {
		const toolset = new Map<string, Tool>([
			["slow", tool("slow", () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 2000)), 50)],
			["fast", tool("fast", async () => ({ ok: true, value: 1 }))]
		]);

		const started = performance.now();
		const results = await runToolCalls([
			{ id: "a", name: "slow", arguments: "{}" },
			{ id: "b", name: "fast", arguments: "{}" }
		], { toolset });

		expect(performance.now() - started).toBeLessThan(1000);
		expect(results.map((result) => result.callId)).toEqual(["a", "b"]);
		expect(JSON.parse(results[0]!.output).error).toContain("timed out");
		expect(JSON.parse(results[1]!.output)).toEqual({ ok: true, value: 1 });
	});

	test("oversized tool output is truncated", async () => {
		const toolset = new Map<string, Tool>([["big", tool("big", async () => ({ ok: true, text: "x".repeat(100_000) }))]]);
		const [result] = await runToolCalls([{ id: "a", name: "big", arguments: "{}" }], { toolset });

		expect(result!.output.length).toBeLessThan(30_000);
		expect(result!.output).toContain("[truncated");
	});
});
