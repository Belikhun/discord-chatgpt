import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, useDatabase } from "../src/db";
import {
	forgetMemory,
	migrateLegacyMemories,
	pinnedMemories,
	saveMemory,
	searchMemories,
	setEmbedder,
	updateMemory,
	userScopeId
} from "../src/stores/memory";
import type { AIProvider } from "../src/ai/types";

/**
 * A deterministic embedder: a bag of concept ids, so "cat" and "kitten" land
 * close together without any network.
 */
const CONCEPTS: Record<string, number> = { cat: 0, kitten: 0, meo: 0, dog: 1, puppy: 1, server: 2, restart: 3, reboot: 3 };

const stubProvider = {
	id: "stub",
	defaultEmbeddingModel: "stub-embed",
	async embed(texts: string[]) {
		return texts.map((text) => {
			const vector = new Float32Array(8);
			for (const word of text.toLowerCase().split(/\W+/)) {
				const concept = CONCEPTS[word];
				if (concept !== undefined)
					vector[concept]! += 1;
			}
			vector[7] = 0.01;
			return vector;
		});
	}
} as unknown as AIProvider;

const g1Alice = { guildId: "g1", channelId: "c1", userId: "alice" };
const g1Bob = { guildId: "g1", channelId: "c2", userId: "bob" };
const g2Alice = { guildId: "g2", channelId: "c9", userId: "alice" };

beforeEach(() => {
	useDatabase(openDatabase(":memory:"));
	setEmbedder({ provider: stubProvider, model: "stub-embed" });
});

describe("memory scopes", () => {
	test("user memories follow the person within a guild, never across guilds", async () => {
		await saveMemory({ scope: { kind: "user", id: userScopeId("g1", "alice") }, guildId: "g1", content: "Alice has a kitten named Mochi" });

		expect((await searchMemories("cat", { ...g1Alice, channelId: "c5" })).length).toBe(1);
		expect((await searchMemories("cat", g1Bob)).length).toBe(0);
		expect((await searchMemories("cat", g2Alice)).length).toBe(0);
	});

	test("guild and channel scopes stay where they were saved", async () => {
		await saveMemory({ scope: { kind: "guild", id: "g1" }, guildId: "g1", content: "The server restarts at 4am" });
		await saveMemory({ scope: { kind: "channel", id: "c1" }, guildId: "g1", content: "This channel plans the dog event" });

		expect((await searchMemories("restart", g1Bob)).length).toBe(1);
		expect((await searchMemories("dog", g1Bob)).length).toBe(0);
		expect((await searchMemories("dog", g1Alice)).length).toBe(1);
		expect((await searchMemories("restart", g2Alice)).length).toBe(0);
	});

	test("update and forget refuse memories outside the viewer's scope", async () => {
		const memory = await saveMemory({ scope: { kind: "guild", id: "g1" }, guildId: "g1", content: "Pinned rule", pinned: true });

		expect(await updateMemory(memory.id, { content: "hijacked" }, g2Alice)).toBeNull();
		expect(forgetMemory(memory.id, g2Alice)).toBeNull();
		expect(pinnedMemories(g1Bob).map((entry) => entry.content)).toEqual(["Pinned rule"]);
		expect(forgetMemory(memory.id, g1Bob)?.id).toBe(memory.id);
		expect(pinnedMemories(g1Bob)).toEqual([]);
	});
});

describe("hybrid search", () => {
	test("finds by meaning when no keyword matches", async () => {
		await saveMemory({ scope: { kind: "guild", id: "g1" }, guildId: "g1", content: "Mochi is a cat" });
		await saveMemory({ scope: { kind: "guild", id: "g1" }, guildId: "g1", content: "Rex is a dog" });

		const hits = await searchMemories("kitten", g1Alice);
		expect(hits[0]?.memory.content).toBe("Mochi is a cat");
	});

	test("folded keywords match Vietnamese text without accents", async () => {
		setEmbedder(null);
		await saveMemory({ scope: { kind: "guild", id: "g1" }, guildId: "g1", content: "Mùa đông ở survival rất lạnh" });

		expect((await searchMemories("mua dong", g1Alice)).length).toBe(1);
	});

	test("an edited memory is re-indexed", async () => {
		setEmbedder(null);
		const memory = await saveMemory({ scope: { kind: "guild", id: "g1" }, guildId: "g1", content: "old fact about apples" });

		await updateMemory(memory.id, { content: "new fact about pears" }, g1Alice);

		expect((await searchMemories("apples", g1Alice)).length).toBe(0);
		expect((await searchMemories("pears", g1Alice)).length).toBe(1);
	});

	test("expired memories are not recalled", async () => {
		await saveMemory({ scope: { kind: "guild", id: "g1" }, guildId: "g1", content: "temporary cat note", ttlSeconds: 0.001 });
		await Bun.sleep(5);

		expect((await searchMemories("cat", g1Alice)).length).toBe(0);
	});
});

describe("legacy import", () => {
	test("imports live items as guild memories and renames the file", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-mem-"));
		const file = path.join(dir, "memories.json");
		const now = Date.now();

		fs.writeFileSync(file, JSON.stringify({
			g1: [
				{ id: "a", content: "still valid", createdAt: now, expiresAt: now + 60_000, authorId: "u", channelId: "c", messageId: "m" },
				{ id: "b", content: "long gone", createdAt: now - 10, expiresAt: now - 5, authorId: null, channelId: null, messageId: null }
			]
		}));

		expect(migrateLegacyMemories(file)).toBe(1);
		expect(fs.existsSync(file)).toBe(false);
		expect(fs.existsSync(`${file}.migrated`)).toBe(true);
		expect(migrateLegacyMemories(file)).toBe(0);

		fs.rmSync(dir, { recursive: true, force: true });
	});
});
