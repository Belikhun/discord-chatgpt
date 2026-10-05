import { scope } from "../logger";
import type { ToolCall, ToolResultItem } from "../ai/types";
import type { TurnProgress } from "../conversation/types";
import type { BridgeClient } from "./client";

const log = scope("minecraft-progress");

/** How long the finished bar stays up before it is taken down. */
const DONE_LINGER_MS = 1_500;

/** What players read for a built-in tool; MCP tools show as `server › tool`. */
const TOOL_LABELS: Record<string, string> = {
	web_search: "tìm kiếm trên web",
	fetch_webpage: "đọc trang web",
	memory_save: "ghi nhớ",
	memory_update: "ghi nhớ",
	memory_forget: "xoá ghi nhớ",
	memory_search: "lục lại trí nhớ",
	memory_list: "lục lại trí nhớ",
	minecraft_wiki_search: "tra Minecraft Wiki",
	minecraft_wiki_search_content: "tra Minecraft Wiki",
	minecraft_wiki_read_content: "đọc Minecraft Wiki"
};

function toolLabel(name: string): string {
	return TOOL_LABELS[name] ?? name.replace("__", " › ");
}

function escapeMini(text: string): string {
	return text.replace(/[<>\\]/g, (char) => `\\${char}`);
}

/** Where a bar goes: the named players, one server, or everyone. */
export interface BarAudience {
	players?: string[];
	server?: string;
}

/**
 * A reply's progress as a boss bar. Minecraft chat cannot be edited once
 * sent, so the bar is the only live indicator: it appears when the bot was
 * addressed or reaches for a tool, names the tool it is running, turns red
 * when one fails, and comes down once the answer is in chat.
 *
 * Updates for one bar are chained so they land in order; each one carries a
 * TTL so the proxy takes the bar down by itself if the bot dies mid-turn.
 */
export class BossbarProgress implements TurnProgress {
	private turn = 0;
	private barId: string | null = null;
	private steps = 0;
	private chain: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly client: BridgeClient,
		private readonly key: string,
		private readonly botName: () => string,
		private readonly audience: () => BarAudience
	) {}

	start(explicit: boolean): void {
		this.turn += 1;
		this.barId = `${this.key}:${this.turn}`;
		this.steps = 0;

		if (explicit)
			this.show(`<white>💬 <aqua>${escapeMini(this.botName())}</aqua> đang suy nghĩ…</white>`, 0.1, "blue");
	}

	tools(calls: ToolCall[]): void {
		if (calls.length === 0)
			return;

		this.steps += 1;

		const labels = [...new Set(calls.map((call) => toolLabel(call.name)))].join(", ");
		this.show(`<white>⌛ <aqua>${escapeMini(this.botName())}</aqua> đang ${escapeMini(labels)}…</white>`, this.progress(), "blue");
	}

	toolsDone(calls: ToolCall[], outputs: ToolResultItem[]): void {
		const failed = outputs.some((output) => {
			try {
				return JSON.parse(output.output)?.ok === false;
			} catch {
				return false;
			}
		});

		const title = failed
			? `<white>⚠ <aqua>${escapeMini(this.botName())}</aqua> gặp lỗi khi dùng công cụ, đang xử lý tiếp…</white>`
			: `<white>💬 <aqua>${escapeMini(this.botName())}</aqua> đang soạn câu trả lời…</white>`;

		this.show(title, this.progress(), failed ? "red" : "blue");
	}

	end(sent: boolean): void {
		const id = this.barId;
		this.barId = null;

		if (!id || !this.shownIds.has(id))
			return;

		if (sent)
			this.enqueue(id, { action: "show", title: `<white>✔ <aqua>${escapeMini(this.botName())}</aqua> đã trả lời</white>`, progress: 1, color: "green", overlay: "progress", ttlSeconds: 30, ...this.audience() });

		this.enqueue(id, { action: "hide" }, sent ? DONE_LINGER_MS : 0);
		this.shownIds.delete(id);
	}

	private shownIds = new Set<string>();

	/** Climbs toward the end without reaching it: the step count is not known up front. */
	private progress(): number {
		return Math.min(0.9, 1 - 0.9 * Math.pow(0.7, this.steps));
	}

	// Every show names its audience: the proxy reads a show without one as "everyone".
	private show(title: string, progress: number, color: string): void {
		const id = this.barId;
		if (!id)
			return;

		this.shownIds.add(id);
		this.enqueue(id, { action: "show", title, progress, color, overlay: "progress", ttlSeconds: 120, ...this.audience() });
	}

	private enqueue(id: string, body: Record<string, any>, delayMs = 0): void {
		this.chain = this.chain
			.then(() => delayMs > 0 ? new Promise((resolve) => setTimeout(resolve, delayMs)) : undefined)
			.then(() => this.client.post("/messenger/bridge/bossbar", { id, ...body }))
			.catch((err: any) => log.warn(`Boss bar ${body.action} failed: ${err?.message || err}`));
	}
}

/** For a disabled bar: the same calls, doing nothing. */
export const NO_PROGRESS: TurnProgress = {
	start() {},
	tools() {},
	toolsDone() {},
	end() {}
};
