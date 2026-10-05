import fs from "node:fs";
import path from "node:path";
import { scope } from "../logger";
import { env } from "../env";
import { db, foldText } from "../db";
import { getDefaultProvider, getProvider } from "../ai/registry";
import type { AIProvider } from "../ai/types";

const log = scope("memory-store");

/**
 * Who a memory is about, which is also who gets to see it:
 *
 * - `user`: a person, within one guild (or within their DMs with the bot).
 *   Recalled whenever that person is the one talking, in any channel there.
 * - `channel`: one channel's running context.
 * - `guild`: the whole server.
 * - `global`: everywhere; only ever written by the bot owner's config.
 *
 * Scopes never cross guilds. A memory saved in one server is invisible in
 * every other server and in DMs.
 */
export type MemoryScopeKind = "user" | "channel" | "guild" | "global";

export interface Memory {
	id: string;
	scope: { kind: MemoryScopeKind; id: string };
	guildId: string | null;
	content: string;
	tags: string[];
	authorId: string | null;
	pinned: boolean;
	createdAt: number;
	updatedAt: number;
	expiresAt: number | null;
}

/** Where a request comes from; decides which memories it may see. */
export interface MemoryViewer {
	guildId: string | null;
	channelId: string | null;
	userId: string | null;
}

export interface MemoryHit {
	memory: Memory;
	score: number;
}

/** Most rows a semantic search scores in one go. */
const MAX_VECTOR_CANDIDATES = 2000;

/** Reciprocal-rank-fusion constant; the usual 60. */
const RRF_K = 60;

/** Cosine similarity below which a semantic match is noise. */
const MIN_SIMILARITY = 0.25;

/** The scope id of a person: per guild, so a user memory never leaves its server. */
export function userScopeId(guildId: string | null, userId: string): string {
	return `${guildId ?? "dm"}:${userId}`;
}

interface MemoryRow {
	id: string;
	scope_kind: MemoryScopeKind;
	scope_id: string;
	guild_id: string | null;
	content: string;
	tags: string;
	author_id: string | null;
	pinned: number;
	created_at: number;
	updated_at: number;
	expires_at: number | null;
	embedding: Uint8Array | null;
	embedding_model: string | null;
}

function toMemory(row: MemoryRow): Memory {
	return {
		id: row.id,
		scope: { kind: row.scope_kind, id: row.scope_id },
		guildId: row.guild_id,
		content: row.content,
		tags: row.tags ? row.tags.split(",") : [],
		authorId: row.author_id,
		pinned: !!row.pinned,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		expiresAt: row.expires_at
	};
}

/** The SQL condition (and its parameters) for "rows this viewer may see". */
function visibility(viewer: MemoryViewer): { sql: string; params: (string | number)[] } {
	const clauses = ["m.scope_kind = 'global'"];
	const params: (string | number)[] = [];

	if (viewer.guildId) {
		clauses.push("(m.scope_kind = 'guild' AND m.scope_id = ?)");
		params.push(viewer.guildId);
	}

	if (viewer.channelId) {
		clauses.push("(m.scope_kind = 'channel' AND m.scope_id = ?)");
		params.push(viewer.channelId);
	}

	if (viewer.userId) {
		clauses.push("(m.scope_kind = 'user' AND m.scope_id = ?)");
		params.push(userScopeId(viewer.guildId, viewer.userId));
	}

	return {
		sql: `(${clauses.join(" OR ")}) AND (m.expires_at IS NULL OR m.expires_at > ${Date.now()})`,
		params
	};
}

// -- embeddings ---------------------------------------------------------------

let embedder: { provider: AIProvider; model: string } | null | undefined;

/**
 * The provider and model memories are embedded with: `EMBEDDING` in env.json,
 * else the default provider's own embedding model. Null when nothing is
 * configured, and search then runs on full-text alone.
 */
export function getEmbedder(): { provider: AIProvider; model: string } | null {
	if (embedder !== undefined)
		return embedder;

	try {
		const provider = env.EMBEDDING?.PROVIDER
			? getProvider(env.EMBEDDING.PROVIDER)
			: getDefaultProvider();

		embedder = { provider, model: env.EMBEDDING?.MODEL || provider.defaultEmbeddingModel };
	} catch (err: any) {
		log.warn(`Embeddings unavailable, memory search falls back to full-text only: ${err?.message || err}`);
		embedder = null;
	}

	return embedder;
}

/** Swap the embedder; tests use a deterministic stub. */
export function setEmbedder(value: { provider: AIProvider; model: string } | null): void {
	embedder = value;
	queryCache.clear();
}

function encodeVector(vector: Float32Array): Uint8Array {
	return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

function decodeVector(blob: Uint8Array): Float32Array {
	const copy = new Uint8Array(blob);
	return new Float32Array(copy.buffer);
}

function cosine(a: Float32Array, b: Float32Array): number {
	if (a.length !== b.length || a.length === 0)
		return 0;

	let dot = 0;
	let normA = 0;
	let normB = 0;

	for (let i = 0; i < a.length; i++) {
		dot += a[i]! * b[i]!;
		normA += a[i]! * a[i]!;
		normB += b[i]! * b[i]!;
	}

	return (normA && normB) ? dot / Math.sqrt(normA * normB) : 0;
}

/** Text a memory is embedded and indexed as: its content plus its tags. */
function indexText(content: string, tags: string[]): string {
	return tags.length ? `${content}\n${tags.join(" ")}` : content;
}

async function embedOne(text: string): Promise<{ vector: Float32Array; model: string } | null> {
	const current = getEmbedder();
	if (!current)
		return null;

	try {
		const [vector] = await current.provider.embed([text], current.model);
		return vector?.length ? { vector, model: current.model } : null;
	} catch (err: any) {
		log.warn(`Embedding failed: ${err?.message || err}`);
		return null;
	}
}

/**
 * Query embeddings, cached briefly: one Discord message is searched for by the
 * auto-retrieval and often again by the model's own memory_search.
 */
const queryCache = new Map<string, { at: number; vector: Float32Array | null }>();

async function embedQuery(query: string): Promise<Float32Array | null> {
	const key = query.trim().slice(0, 2000);
	const hit = queryCache.get(key);

	if (hit && Date.now() - hit.at < 5 * 60_000)
		return hit.vector;

	const result = await embedOne(key);
	queryCache.set(key, { at: Date.now(), vector: result?.vector ?? null });

	if (queryCache.size > 200)
		queryCache.delete(queryCache.keys().next().value!);

	return result?.vector ?? null;
}

// -- writes ---------------------------------------------------------------------

export interface SaveMemoryInput {
	scope: { kind: MemoryScopeKind; id: string };
	guildId: string | null;
	content: string;
	tags?: string[] | null;
	authorId?: string | null;
	sourceChannelId?: string | null;
	sourceMessageId?: string | null;
	pinned?: boolean;
	ttlSeconds?: number | null;
}

function cleanTags(tags: string[] | undefined | null): string[] {
	const cleaned = (tags ?? [])
		.map((tag) => tag.trim().toLowerCase().replace(/,/g, " "))
		.filter(Boolean);

	return [...new Set(cleaned)].slice(0, 12);
}

function writeIndex(id: string, content: string, tags: string[]): void {
	db().run("DELETE FROM memories_fts WHERE id = ?", [id]);
	db().run("INSERT INTO memories_fts (id, text) VALUES (?, ?)", [id, foldText(indexText(content, tags))]);
}

/** Store a memory and index it; the embedding is computed inline, best effort. */
export async function saveMemory(input: SaveMemoryInput): Promise<Memory> {
	const content = input.content.trim();
	if (!content)
		throw new Error("Memory content cannot be empty.");

	const now = Date.now();
	const tags = cleanTags(input.tags);
	const embedded = await embedOne(indexText(content, tags));
	const id = `mem_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
	const expiresAt = (typeof input.ttlSeconds === "number" && input.ttlSeconds > 0)
		? now + Math.floor(input.ttlSeconds * 1000)
		: null;

	db().run(
		`INSERT INTO memories (id, scope_kind, scope_id, guild_id, content, tags, author_id, source_channel_id,
			source_message_id, pinned, created_at, updated_at, expires_at, embedding, embedding_model)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			id, input.scope.kind, input.scope.id, input.guildId, content, tags.join(","), input.authorId ?? null,
			input.sourceChannelId ?? null, input.sourceMessageId ?? null, input.pinned ? 1 : 0, now, now, expiresAt,
			embedded ? encodeVector(embedded.vector) : null, embedded?.model ?? null
		]
	);

	writeIndex(id, content, tags);
	return getMemory(id)!;
}

/** One memory by id, regardless of scope; callers check visibility themselves. */
export function getMemory(id: string): Memory | null {
	const row = db().query("SELECT * FROM memories m WHERE id = ?").get(id) as MemoryRow | null;
	return row ? toMemory(row) : null;
}

/** One memory, only if this viewer may see it. */
export function getVisibleMemory(id: string, viewer: MemoryViewer): Memory | null {
	const { sql, params } = visibility(viewer);
	const row = db().query(`SELECT * FROM memories m WHERE m.id = ? AND ${sql}`).get(id, ...params) as MemoryRow | null;
	return row ? toMemory(row) : null;
}

export interface MemoryPatch {
	content?: string | null;
	tags?: string[] | null;
	pinned?: boolean | null;
}

/** Change a memory this viewer can see. Returns null when it cannot. */
export async function updateMemory(id: string, patch: MemoryPatch, viewer: MemoryViewer): Promise<Memory | null> {
	const current = getVisibleMemory(id, viewer);
	if (!current)
		return null;

	const content = patch.content?.trim() || current.content;
	const tags = patch.tags ? cleanTags(patch.tags) : current.tags;
	const pinned = patch.pinned ?? current.pinned;
	const textChanged = content !== current.content || tags.join(",") !== current.tags.join(",");

	db().run("UPDATE memories SET content = ?, tags = ?, pinned = ?, updated_at = ? WHERE id = ?", [content, tags.join(","), pinned ? 1 : 0, Date.now(), id]);

	if (textChanged) {
		const embedded = await embedOne(indexText(content, tags));

		db().run("UPDATE memories SET embedding = ?, embedding_model = ? WHERE id = ?", [
			embedded ? encodeVector(embedded.vector) : null,
			embedded?.model ?? null,
			id
		]);

		writeIndex(id, content, tags);
	}

	return getMemory(id);
}

/** Delete a memory this viewer can see. */
export function forgetMemory(id: string, viewer: MemoryViewer): Memory | null {
	const current = getVisibleMemory(id, viewer);
	if (!current)
		return null;

	db().run("DELETE FROM memories WHERE id = ?", [id]);
	db().run("DELETE FROM memories_fts WHERE id = ?", [id]);
	return current;
}

// -- reads ------------------------------------------------------------------------

/** Visible memories, newest first, optionally of one scope kind. */
export function listMemories(viewer: MemoryViewer, { kind = null, limit = 20 }: { kind?: MemoryScopeKind | null; limit?: number } = {}): Memory[] {
	const { sql, params } = visibility(viewer);
	const kindClause = kind ? "AND m.scope_kind = ?" : "";
	const rows = db().query(`SELECT * FROM memories m WHERE ${sql} ${kindClause} ORDER BY m.updated_at DESC LIMIT ?`)
		.all(...params, ...(kind ? [kind] : []), Math.max(1, Math.min(100, limit))) as MemoryRow[];

	return rows.map(toMemory);
}

/** Pinned memories this viewer can see; always injected, whatever the query. */
export function pinnedMemories(viewer: MemoryViewer, limit: number = 12): Memory[] {
	const { sql, params } = visibility(viewer);
	const rows = db().query(`SELECT * FROM memories m WHERE ${sql} AND m.pinned = 1 ORDER BY m.updated_at DESC LIMIT ?`)
		.all(...params, limit) as MemoryRow[];

	return rows.map(toMemory);
}

/** Build an FTS5 query from free text: each folded word as a prefix term, OR-ed. */
function ftsQuery(query: string): string | null {
	const words = foldText(query)
		.split(/[^\p{L}\p{N}]+/u)
		.filter((word) => word.length > 1)
		.slice(0, 16);

	if (words.length === 0)
		return null;

	return words.map((word) => `"${word}"*`).join(" OR ");
}

/**
 * Rank visible memories against a query: full-text (bm25) and semantic
 * (cosine over stored embeddings) rankings fused by reciprocal rank, so a
 * memory found by both comes first and one found by either still surfaces.
 */
export async function searchMemories(query: string, viewer: MemoryViewer, limit: number = 8): Promise<MemoryHit[]> {
	const { sql, params } = visibility(viewer);
	const fused = new Map<string, { row: MemoryRow; score: number }>();
	const match = ftsQuery(query);

	if (match) {
		const rows = db().query(
			`SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.id
			WHERE memories_fts MATCH ? AND ${sql}
			ORDER BY bm25(memories_fts) LIMIT 50`
		).all(match, ...params) as MemoryRow[];

		rows.forEach((row, rank) => {
			fused.set(row.id, { row, score: 1 / (RRF_K + rank + 1) });
		});
	}

	const current = getEmbedder();
	const vector = current ? await embedQuery(query) : null;

	if (vector && current) {
		const rows = db().query(
			`SELECT * FROM memories m WHERE ${sql} AND m.embedding IS NOT NULL AND m.embedding_model = ?
			ORDER BY m.updated_at DESC LIMIT ${MAX_VECTOR_CANDIDATES}`
		).all(...params, current.model) as MemoryRow[];

		const ranked = rows
			.map((row) => ({ row, similarity: cosine(vector, decodeVector(row.embedding!)) }))
			.filter((entry) => entry.similarity >= MIN_SIMILARITY)
			.sort((a, b) => b.similarity - a.similarity)
			.slice(0, 50);

		ranked.forEach(({ row }, rank) => {
			const existing = fused.get(row.id);
			const score = 1 / (RRF_K + rank + 1);

			fused.set(row.id, { row, score: (existing?.score ?? 0) + score });
		});
	}

	return [...fused.values()]
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map(({ row, score }) => ({ memory: toMemory(row), score }));
}

// -- maintenance ------------------------------------------------------------------

/** Drop expired memories. */
export function purgeExpiredMemories(): number {
	const expired = db().query("SELECT id FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ?").all(Date.now()) as { id: string }[];

	for (const { id } of expired) {
		db().run("DELETE FROM memories WHERE id = ?", [id]);
		db().run("DELETE FROM memories_fts WHERE id = ?", [id]);
	}

	return expired.length;
}

/**
 * Embed every memory that has no vector for the current embedding model, in
 * batches. Runs at startup, so switching `EMBEDDING.MODEL` re-embeds the store
 * instead of silently dropping the old vectors out of search.
 */
export async function backfillEmbeddings(batchSize: number = 64): Promise<number> {
	const current = getEmbedder();
	if (!current)
		return 0;

	let done = 0;

	while (true) {
		const rows = db().query(
			"SELECT id, content, tags FROM memories WHERE embedding IS NULL OR embedding_model IS NOT ? LIMIT ?"
		).all(current.model, batchSize) as { id: string; content: string; tags: string }[];

		if (rows.length === 0)
			break;

		let vectors: Float32Array[];

		try {
			vectors = await current.provider.embed(rows.map((row) => indexText(row.content, row.tags ? row.tags.split(",") : [])), current.model);
		} catch (err: any) {
			log.warn(`Embedding backfill stopped: ${err?.message || err}`);
			break;
		}

		const update = db().prepare("UPDATE memories SET embedding = ?, embedding_model = ? WHERE id = ?");
		let written = 0;

		db().transaction(() => {
			rows.forEach((row, index) => {
				const vector = vectors[index];
				if (!vector?.length)
					return;

				update.run(encodeVector(vector), current.model, row.id);
				written += 1;
			});
		})();

		done += written;

		// A batch the provider could not embed would come back forever.
		if (written === 0 || rows.length < batchSize)
			break;
	}

	if (done > 0)
		log.info(`Embedded ${done} memory item(s) with ${current.model}.`);

	return done;
}

interface LegacyMemoryItem {
	id: string;
	content: string;
	createdAt: number;
	expiresAt: number;
	authorId: string | null;
	channelId: string | null;
	messageId: string | null;
}

/**
 * One-time import of the old `data/memories.json` (guild-scoped, 24 h items)
 * into the database. Expired items are left behind; the file is renamed so the
 * import never runs twice.
 */
export function migrateLegacyMemories(file: string = path.join(process.cwd(), "data", "memories.json")): number {
	if (!fs.existsSync(file))
		return 0;

	let legacy: Record<string, LegacyMemoryItem[]>;

	try {
		legacy = JSON.parse(fs.readFileSync(file, "utf8") || "{}");
	} catch (err: any) {
		log.error(`Cannot read ${file} for migration: ${err.message}`);
		return 0;
	}

	const now = Date.now();
	let imported = 0;

	db().transaction(() => {
		for (const [guildId, items] of Object.entries(legacy)) {
			for (const item of items ?? []) {
				if (!item?.content || (item.expiresAt ?? 0) <= now)
					continue;

				const id = `mem_legacy_${item.id}`.replace(/[^\w-]/g, "_");
				const createdAt = item.createdAt ?? now;

				db().run(
					`INSERT OR IGNORE INTO memories (id, scope_kind, scope_id, guild_id, content, tags, author_id,
						source_channel_id, source_message_id, pinned, created_at, updated_at, expires_at)
					VALUES (?, 'guild', ?, ?, ?, '', ?, ?, ?, 0, ?, ?, ?)`,
					[id, guildId, guildId, item.content, item.authorId, item.channelId, item.messageId, createdAt, createdAt, item.expiresAt]
				);

				writeIndex(id, item.content, []);
				imported += 1;
			}
		}
	})();

	fs.renameSync(file, `${file}.migrated`);
	log.info(`Imported ${imported} memory item(s) from ${path.basename(file)}.`);

	return imported;
}
