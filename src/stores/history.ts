import { db } from "../db";
import type { ConversationItem, HistoryEntry } from "../ai/types";

/**
 * Conversation history on disk, so a restart resumes every channel where it
 * left off instead of starting from nothing.
 *
 * Rows are append-only per conversation, numbered by `seq` and grouped by
 * `turn`: a turn starts with a user (or developer) message and owns every model
 * item and tool result that follows it. Compaction removes whole turns, which
 * is what keeps a function call and its output from ever being separated.
 */

export interface StoredConversation {
	summary: string;
	entries: HistoryEntry[];
}

interface HistoryRow {
	seq: number;
	turn: number;
	item: string;
	tokens: number;
	created_at: number;
}

/** Load a conversation's summary and remaining history, oldest first. */
export function loadHistory(key: string): StoredConversation {
	const meta = db().query("SELECT summary FROM conversations WHERE key = ?").get(key) as { summary: string } | null;
	const rows = db().query("SELECT seq, turn, item, tokens, created_at FROM history_items WHERE conversation_key = ? ORDER BY seq").all(key) as HistoryRow[];

	return {
		summary: meta?.summary ?? "",
		entries: rows.map((row) => ({
			item: JSON.parse(row.item) as ConversationItem,
			timestamp: row.created_at,
			seq: row.seq,
			turn: row.turn,
			tokens: row.tokens
		}))
	};
}

export interface ConversationMeta {
	guildId: string | null;
	channelId: string | null;
	mode: string;
}

/** Append entries (which already carry their seq, turn and token estimate). */
export function appendHistory(key: string, meta: ConversationMeta, entries: HistoryEntry[]): void {
	const insert = db().prepare("INSERT OR REPLACE INTO history_items (conversation_key, seq, turn, item, tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)");

	db().transaction(() => {
		db().run(
			`INSERT INTO conversations (key, guild_id, channel_id, mode, updated_at) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT (key) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`,
			[key, meta.guildId, meta.channelId, meta.mode, Date.now()]
		);

		for (const entry of entries)
			insert.run(key, entry.seq ?? 0, entry.turn ?? 0, JSON.stringify(entry.item), entry.tokens ?? 0, entry.timestamp);
	})();
}

/** Replace the rolling summary and drop every row up to and including `throughSeq`. */
export function compactHistory(key: string, summary: string, throughSeq: number): void {
	db().transaction(() => {
		db().run("UPDATE conversations SET summary = ?, summary_upto = ?, updated_at = ? WHERE key = ?", [summary, throughSeq, Date.now(), key]);
		db().run("DELETE FROM history_items WHERE conversation_key = ? AND seq <= ?", [key, throughSeq]);
	})();
}

/** Forget a conversation entirely (/clear, or a model or mode change). */
export function clearHistory(key: string): void {
	db().transaction(() => {
		db().run("DELETE FROM history_items WHERE conversation_key = ?", [key]);
		db().run("DELETE FROM conversations WHERE key = ?", [key]);
	})();
}
