import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { scope } from "../logger";

const log = scope("db");

/**
 * Schema migrations, applied in order and tracked with `PRAGMA user_version`.
 * Append only: a shipped migration is never edited, a change is a new entry.
 */
const MIGRATIONS: string[] = [
	// 1: memories, conversation history, MCP enablement
	`
	CREATE TABLE memories (
		id TEXT PRIMARY KEY,
		scope_kind TEXT NOT NULL CHECK (scope_kind IN ('user', 'channel', 'guild', 'global')),
		scope_id TEXT NOT NULL,
		guild_id TEXT,
		content TEXT NOT NULL,
		tags TEXT NOT NULL DEFAULT '',
		author_id TEXT,
		source_channel_id TEXT,
		source_message_id TEXT,
		pinned INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		expires_at INTEGER,
		embedding BLOB,
		embedding_model TEXT
	);

	CREATE INDEX memories_scope ON memories (scope_kind, scope_id);
	CREATE INDEX memories_guild ON memories (guild_id);

	-- standalone rather than external-content: the indexed text is a folded
	-- copy (see foldText) that the memory store writes alongside each row
	CREATE VIRTUAL TABLE memories_fts USING fts5 (id UNINDEXED, text, tokenize = 'unicode61');

	CREATE TABLE conversations (
		key TEXT PRIMARY KEY,
		guild_id TEXT,
		channel_id TEXT,
		mode TEXT,
		summary TEXT NOT NULL DEFAULT '',
		summary_upto INTEGER NOT NULL DEFAULT 0,
		updated_at INTEGER NOT NULL
	);

	CREATE TABLE history_items (
		conversation_key TEXT NOT NULL,
		seq INTEGER NOT NULL,
		turn INTEGER NOT NULL,
		item TEXT NOT NULL,
		tokens INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		PRIMARY KEY (conversation_key, seq)
	);

	CREATE TABLE mcp_enablement (
		server_id TEXT NOT NULL,
		scope_kind TEXT NOT NULL CHECK (scope_kind IN ('guild', 'channel')),
		scope_id TEXT NOT NULL,
		enabled INTEGER NOT NULL,
		set_by TEXT,
		set_at INTEGER NOT NULL,
		PRIMARY KEY (server_id, scope_kind, scope_id)
	);
	`
];

/** Open (and migrate) a database file. Tests pass ":memory:". */
export function openDatabase(file: string): Database {
	if (file !== ":memory:")
		fs.mkdirSync(path.dirname(file), { recursive: true });

	const database = new Database(file, { create: true });

	database.exec("PRAGMA journal_mode = WAL;");
	database.exec("PRAGMA foreign_keys = ON;");
	migrate(database);

	return database;
}

function migrate(database: Database): void {
	const row = database.query("PRAGMA user_version").get() as { user_version: number };
	let version = row.user_version;

	while (version < MIGRATIONS.length) {
		const sql = MIGRATIONS[version]!;

		database.transaction(() => {
			database.exec(sql);
			database.exec(`PRAGMA user_version = ${version + 1}`);
		})();

		version += 1;
		log.info(`Database migrated to schema ${version}.`);
	}
}

/**
 * Fold text for search: lowercase, accents stripped, and the Vietnamese "đ"
 * mapped to "d", which Unicode treats as its own letter rather than an
 * accented one, so no tokenizer folds it. Indexed text and queries both go
 * through this, which is what makes "dong" find "đông".
 */
export function foldText(text: string): string {
	return text
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[đĐ]/g, "d")
		.toLowerCase();
}

let instance: Database | null = null;

/**
 * The bot's database, `data/bot.sqlite` under the working directory, opened
 * on first use so importing a store does not touch the disk.
 */
export function db(): Database {
	instance ??= openDatabase(path.join(process.cwd(), "data", "bot.sqlite"));
	return instance;
}

/** Point every store at another database; how tests get an isolated one. */
export function useDatabase(database: Database): void {
	instance = database;
}
