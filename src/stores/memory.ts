import fs from "node:fs";
import path from "node:path";
import type { Guild } from "discord.js";
import { scope } from "../logger";
import { env } from "../env";
import config from "../config";
import { getDefaultProvider } from "../ai/registry";
import { listConversations } from "../conversation/store";
import { applyMemorySummaryToConversation } from "../conversation/memorySummary";
import type { ToolContext } from "../tools/types";

const log = scope("memory-store");
export const memoryFilePath = path.join(process.cwd(), "data", "memories.json");
export const memoryTtlMs = 86400000;

export interface MemoryItem {
	id: string;
	content: string;
	createdAt: number;
	expiresAt: number;
	authorId: string | null;
	channelId: string | null;
	messageId: string | null;
}

type MemoryStore = Record<string, MemoryItem[]>;

export function ensureMemoryStore(): void {
	if (!fs.existsSync(memoryFilePath)) {
		fs.mkdirSync(path.dirname(memoryFilePath), { recursive: true });
		fs.writeFileSync(memoryFilePath, "{}", "utf8");
	}
}

export function loadMemoryStore(): MemoryStore {
	ensureMemoryStore();
	try {
		const raw = fs.readFileSync(memoryFilePath, "utf8");
		return JSON.parse(raw || "{}");
	} catch (err: any) {
		log.error(`Failed to read memories.json: ${err.message}`);
		return {};
	}
}

export function saveMemoryStore(store: MemoryStore): void {
	ensureMemoryStore();
	fs.writeFileSync(memoryFilePath, JSON.stringify(store, null, 2), "utf8");
}

export function purgeExpiredMemories(store: MemoryStore): boolean {
	let changed = false;
	const now = Date.now();

	for (const guildId of Object.keys(store)) {
		const items = Array.isArray(store[guildId]) ? store[guildId] : [];
		const fresh = items.filter((item) => (item?.expiresAt ?? 0) > now);
		if (fresh.length !== items.length) {
			store[guildId] = fresh;
			changed = true;
		}
	}

	return changed;
}

export function listMemoriesForGuild(guild: Guild, { query, limit }: { query?: string | null; limit?: number | null } = {}) {
	const store = loadMemoryStore();
	const changed = purgeExpiredMemories(store);
	if (changed)
		saveMemoryStore(store);

	let items = Array.isArray(store[guild.id]) ? store[guild.id] as MemoryItem[] : [];
	if (query) {
		const needle = query.toLowerCase();
		items = items.filter((item) => (item?.content || "").toLowerCase().includes(needle));
	}

	items = items.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
	const max = Math.max(1, Math.min(100, limit ?? 20));
	const sliced = items.slice(0, max);

	return {
		ok: true,
		total: items.length,
		items: sliced
	};
}

export async function createMemoryForGuild(guild: Guild, {
	content,
	ttlSeconds,
	context,
	model
}: {
	content?: string | null;
	ttlSeconds?: number | null;
	context?: ToolContext;
	model?: string | null;
} = {}) {
	const trimmed = (content || "").trim();
	if (!trimmed) {
		return { ok: false, error: "Memory content cannot be empty." };
	}

	const store = loadMemoryStore();
	purgeExpiredMemories(store);
	if (!store[guild.id])
		store[guild.id] = [];

	const now = Date.now();
	const ttlMs = (typeof ttlSeconds === "number" && Number.isFinite(ttlSeconds) && ttlSeconds > 0)
		? Math.floor(ttlSeconds * 1000)
		: memoryTtlMs;
	const item: MemoryItem = {
		id: `${guild.id}-${now}-${Math.random().toString(36).slice(2, 8)}`,
		content: trimmed,
		createdAt: now,
		expiresAt: now + ttlMs,
		authorId: context?.message?.author?.id || null,
		channelId: context?.message?.channel?.id || null,
		messageId: context?.message?.id || null
	};

	(store[guild.id] as MemoryItem[]).push(item);
	saveMemoryStore(store);

	generateAndApplyMemorySummary(guild.id, store, model || context?.conversation?.model).catch((err) => {
		log.error(`Failed to update memory summary: ${err?.message || err}`);
	});

	return { ok: true, item };
}

async function generateAndApplyMemorySummary(guildId: string, store: MemoryStore, model?: string | null): Promise<void> {
	const items = Array.isArray(store[guildId]) ? store[guildId] as MemoryItem[] : [];
	if (items.length === 0)
		return;

	const summaryModel = model || env.MODEL_DEFAULT || "gpt-5.6-luna";
	const instructions = "Summarize the following Discord memory items into a short, helpful summary for future replies. Use the same language as the memories. Keep it to 1-3 sentences. Do not include IDs.";
	const inputText = items
		.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
		.map((item, index) => `${index + 1}. ${item.content}`)
		.join("\n");

	const summary = await getDefaultProvider().generateText({
		model: summaryModel,
		instructions,
		input: inputText
	});

	if (!summary)
		return;

	const summaries = config.get<Record<string, string>>("memorySummaries", {});
	config.set("memorySummaries", {
		...summaries,
		[guildId]: summary
	});

	for (const conversation of listConversations()) {
		if (!conversation?.channel?.guild || conversation.channel.guild.id !== guildId)
			continue;

		applyMemorySummaryToConversation(conversation, summary);
	}
}
