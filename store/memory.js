import fs from "node:fs";
import path from "node:path";
import { scope } from "../logger.js";
import { openAI } from "../clients/openai.js";
import config from "../config/config.js";
import env from "../env.json" with { type: "json" };
import { listConversations } from "./conversation.js";

const log = scope("memory-store");
export const memoryFilePath = path.join(process.cwd(), "data", "memories.json");
export const memoryTtlMs = 86400000;

export function ensureMemoryStore() {
	if (!fs.existsSync(memoryFilePath)) {
		fs.mkdirSync(path.dirname(memoryFilePath), { recursive: true });
		fs.writeFileSync(memoryFilePath, "{}", "utf8");
	}
}

export function loadMemoryStore() {
	ensureMemoryStore();
	try {
		const raw = fs.readFileSync(memoryFilePath, "utf8");
		return JSON.parse(raw || "{}");
	} catch (err) {
		log.error(`Failed to read memories.json: ${err.message}`);
		return {};
	}
}

export function saveMemoryStore(store) {
	ensureMemoryStore();
	fs.writeFileSync(memoryFilePath, JSON.stringify(store, null, 2), "utf8");
}

export function purgeExpiredMemories(store) {
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

export function listMemoriesForGuild(guild, { query, limit } = {}) {
	const store = loadMemoryStore();
	const changed = purgeExpiredMemories(store);
	if (changed)
		saveMemoryStore(store);

	let items = Array.isArray(store[guild.id]) ? store[guild.id] : [];
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

export async function createMemoryForGuild(guild, { content, ttlSeconds, context, model } = {}) {
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
	const item = {
		id: `${guild.id}-${now}-${Math.random().toString(36).slice(2, 8)}`,
		content: trimmed,
		createdAt: now,
		expiresAt: now + ttlMs,
		authorId: context?.message?.author?.id || null,
		channelId: context?.message?.channel?.id || null,
		messageId: context?.message?.id || null
	};

	store[guild.id].push(item);
	saveMemoryStore(store);

	generateAndApplyMemorySummary(guild.id, store, model || context?.conversation?.model).catch((err) => {
		log.error(`Failed to update memory summary: ${err?.message || err}`);
	});

	return { ok: true, item };
}

async function generateAndApplyMemorySummary(guildId, store, model) {
	const items = Array.isArray(store[guildId]) ? store[guildId] : [];
	if (items.length === 0)
		return;

	const summaryModel = model || env.MODEL_DEFAULT || "gpt-5-mini";
	const instructions = "Summarize the following Discord memory items into a short, helpful summary for future replies. Use the same language as the memories. Keep it to 1-3 sentences. Do not include IDs.";
	const inputText = items
		.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
		.map((item, index) => `${index + 1}. ${item.content}`)
		.join("\n");

	const response = await openAI.responses.create({
		model: summaryModel,
		instructions,
		input: inputText
	});

	const summary = (response.output_text || extractOutputText(response.output || []) || "").trim();
	if (!summary)
		return;

	const summaries = config.get("memorySummaries", {});
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

function applyMemorySummaryToConversation(conversation, summary) {
	if (!conversation || !summary)
		return;

	const history = Array.isArray(conversation.history) ? conversation.history : [];
	const prefix = "Memory summary:";
	const text = `${prefix}\n${summary}`;

	const isSummaryEntry = (entry) => {
		if (!entry || entry.role !== "developer")
			return false;

		const existing = extractConversationTexts(entry).join("\n");
		return existing.startsWith(prefix);
	};

	const existingIndex = history.findIndex(isSummaryEntry);
	if (existingIndex >= 0)
		history.splice(existingIndex, 1);

	history.unshift({
		role: "developer",
		content: [{ type: "input_text", text }],
		timestamp: Date.now()
	});

	conversation.history = history;
}

function extractConversationTexts(item) {
	const texts = [];
	if (!item)
		return texts;

	const content = item.content;
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

function extractOutputText(output = []) {
	const texts = [];
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
