import { describe, expect, test } from "bun:test";
import { getToolDefinitions, runToolCall, runToolCalls } from "../src/tools/registry";

/**
 * The tool list and its ordering are model-visible (schemas are sent to the
 * provider in array order), and the error envelopes are parsed by the
 * streaming UI — both must stay exactly as they were before the refactor.
 */

const BASE_TOOL_ORDER = [
	"get_user_info",
	"react_message",
	"forward_message",
	"get_server_info",
	"list_memories",
	"create_memory",
	"list_conversations",
	"search_conversation_history",
	"list_emojis",
	"fetch_recent_messages",
	"search_messages",
	"fetch_webpage",
	"minecraft_wiki_search",
	"minecraft_wiki_search_content",
	"minecraft_wiki_read_content"
];

describe("tool definitions", () => {
	test("base tools are offered in the original order, without moderation tools", async () => {
		// Empty context → no guild → no moderation access.
		const definitions = await getToolDefinitions({});
		expect(definitions.map((d) => d.name)).toEqual(BASE_TOOL_ORDER);
	});

	test("every schema keeps strict mode and a fully-required parameter set", async () => {
		for (const definition of await getToolDefinitions({})) {
			expect(definition.strict).toBe(true);

			const parameters = definition.parameters as any;
			expect(parameters.type).toBe("object");
			expect(parameters.additionalProperties).toBe(false);
			// strict mode requires every property to be listed in `required`.
			expect([...(parameters.required || [])].sort())
				.toEqual(Object.keys(parameters.properties || {}).sort());
		}
	});
});

describe("tool dispatch", () => {
	test("invalid arguments JSON returns the original error envelope", async () => {
		const result = await runToolCall({ id: "call_1", name: "get_user_info", arguments: "{not json" });

		expect(result.kind).toBe("tool_result");
		expect(result.callId).toBe("call_1");

		const payload = JSON.parse(result.output);
		expect(payload.ok).toBe(false);
		expect(payload.error).toStartWith("Invalid tool arguments JSON: ");
	});

	test("unknown tool name returns the original error envelope", async () => {
		const result = await runToolCall({ id: "call_2", name: "not_a_tool", arguments: "{}" });

		const payload = JSON.parse(result.output);
		expect(payload).toEqual({ ok: false, error: "Unknown tool: not_a_tool" });
	});

	test("handler exceptions are wrapped as { ok: false, error }", async () => {
		// get_user_info with no resolvable user throws inside the handler.
		const result = await runToolCall({ id: "call_3", name: "get_user_info", arguments: "{\"userId\":\"0\"}" });

		const payload = JSON.parse(result.output);
		expect(payload.ok).toBe(false);
		expect(typeof payload.error).toBe("string");
	});

	test("runToolCalls executes sequentially and preserves order", async () => {
		const results = await runToolCalls([
			{ id: "a", name: "not_a_tool", arguments: "{}" },
			{ id: "b", name: "also_missing", arguments: "{}" }
		]);

		expect(results.map((r) => r.callId)).toEqual(["a", "b"]);
		expect(results.map((r) => JSON.parse(r.output).error)).toEqual([
			"Unknown tool: not_a_tool",
			"Unknown tool: also_missing"
		]);
	});
});
