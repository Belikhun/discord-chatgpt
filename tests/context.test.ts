import { describe, expect, test } from "bun:test";
import { ATTACHMENT_URL_TTL_MS, prepareHistory, startsTurn } from "../src/conversation/context";
import type { HistoryEntry } from "../src/ai/types";

describe("history preparation", () => {
	test("expired attachment URLs become a note, fresh ones are kept", () => {
		const now = Date.now();
		const image = { type: "image" as const, url: "https://cdn.discordapp.com/x.png" };
		const entries: HistoryEntry[] = [
			{ item: { kind: "message", role: "user", content: [image] }, timestamp: now - ATTACHMENT_URL_TTL_MS - 1, turn: 1 },
			{ item: { kind: "message", role: "user", content: [image] }, timestamp: now, turn: 2 }
		];

		const [old, fresh] = prepareHistory(entries, now) as any[];
		expect(old.content[0].type).toBe("text");
		expect(fresh.content[0]).toEqual(image);
	});

	test("bulky tool outputs from old turns are elided, recent ones kept", () => {
		const big = JSON.stringify({ ok: true, text: "y".repeat(5000) });
		const entries: HistoryEntry[] = [
			{ item: { kind: "tool_result", callId: "a", output: big }, timestamp: 0, turn: 1 },
			{ item: { kind: "tool_result", callId: "b", output: big }, timestamp: 0, turn: 9 }
		];

		const [old, recent] = prepareHistory(entries) as any[];
		expect(JSON.parse(old.output).note).toContain("elided");
		expect(recent.output).toBe(big);
	});

	test("turns start at user and developer messages only", () => {
		expect(startsTurn({ kind: "message", role: "user", content: [] })).toBe(true);
		expect(startsTurn({ kind: "message", role: "developer", content: [] })).toBe(true);
		expect(startsTurn({ kind: "message", role: "assistant", content: [] })).toBe(false);
		expect(startsTurn({ kind: "tool_result", callId: "x", output: "" })).toBe(false);
	});
});
