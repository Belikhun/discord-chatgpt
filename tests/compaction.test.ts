import { beforeAll, describe, expect, test } from "bun:test";
import { openDatabase, useDatabase } from "../src/db";
import { registerProvider } from "../src/ai/registry";
import { ChatConversation } from "../src/conversation/ChatConversation";
import { loadHistory } from "../src/stores/history";
import type { AIProvider, ModelInfo } from "../src/ai/types";

const info: ModelInfo = { id: "tiny-model", displayName: "tiny", provider: "tiny", traits: [], contextWindow: 2000 };
const summaries: string[] = [];

const provider: AIProvider = {
	id: "tiny",
	models: [info],
	getModelInfo: () => info,
	hasTrait: () => false,
	respond: async () => ({ items: [], outputText: "", toolCalls: [] }),
	stream: (async function* () { })() as any,
	generateText: async ({ input }) => {
		summaries.push(input);
		return "SUMMARY";
	},
	defaultEmbeddingModel: "none",
	embed: async () => [],
	extractTexts: (item) => [String(item.item.text ?? "")]
};

beforeAll(() => {
	useDatabase(openDatabase(":memory:"));
	registerProvider(provider, { isDefault: true });
});

describe("history compaction", () => {
	test("folds whole oldest turns into the summary, persists it, and keeps tool pairs together", async () => {
		const channel = { id: "c-compact", name: "test", guild: null } as any;
		const conversation = new ChatConversation(channel, "tiny-model", "", "assistant", { key: "c-compact" });

		for (let turn = 0; turn < 12; turn++) {
			conversation.pushHistory({ kind: "message", role: "user", content: [{ type: "text", text: `question ${turn} ${"x".repeat(400)}` }] });
			conversation.pushHistory({ kind: "provider", provider: "tiny", item: { type: "function_call", call_id: `call-${turn}`, text: "" } });
			conversation.pushHistory({ kind: "tool_result", callId: `call-${turn}`, output: "y".repeat(200) });
			conversation.pushHistory({ kind: "provider", provider: "tiny", item: { type: "message", text: `answer ${turn}` } });
		}

		await conversation.compactIfNeeded();

		expect(conversation.summary).toBe("SUMMARY");
		expect(summaries[0]).toContain("question 0");

		// every remaining turn is complete: a call is never left without its output
		const calls = conversation.history.filter((entry) => entry.item.kind === "provider" && (entry.item as any).item.type === "function_call").length;
		const outputs = conversation.history.filter((entry) => entry.item.kind === "tool_result").length;
		expect(outputs).toBe(calls);
		expect(conversation.history[0]!.item.kind).toBe("message");

		// the newest two turns always survive
		const turns = new Set(conversation.history.map((entry) => entry.turn));
		expect(turns.has(12)).toBe(true);
		expect(turns.has(11)).toBe(true);

		// a restart sees the same thing
		const stored = loadHistory("c-compact");
		expect(stored.summary).toBe("SUMMARY");
		expect(stored.entries.length).toBe(conversation.history.length);

		const restored = new ChatConversation(channel, "tiny-model", "", "assistant", { key: "c-compact" }).restore();
		expect(restored.history.map((entry) => entry.seq)).toEqual(conversation.history.map((entry) => entry.seq));
		expect(restored.summary).toBe("SUMMARY");
	});
});
