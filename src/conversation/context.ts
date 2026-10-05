import { env } from "../env";
import { extractItemTexts, getModelInfo } from "../ai/registry";
import type { ConversationItem, HistoryEntry, MessagePart } from "../ai/types";

/** History tokens per request unless env.json says otherwise. */
const DEFAULT_HISTORY_TOKENS = 24_000;

/** Share of a model's window history may take; the rest is instructions, tools and the reply. */
const WINDOW_SHARE = 0.6;

/** How long a Discord attachment URL keeps working; the CDN signs them for about a day. */
export const ATTACHMENT_URL_TTL_MS = 20 * 60 * 60 * 1000;

/** Turns kept at full fidelity; older tool outputs are cut down to a preview. */
const FRESH_TURNS = 4;

/** Tool outputs longer than this are elided once they fall out of the fresh turns. */
const STALE_TOOL_OUTPUT_CHARS = 1500;

/**
 * A model's input window in tokens: the catalogue's figure when it has one,
 * else a family default, else a conservative 128k.
 */
export function contextWindowFor(model: string): number {
	const known = getModelInfo(model).contextWindow;
	if (known)
		return known;

	if (/^gemini/.test(model) || /^gpt-4\.1/.test(model))
		return 1_000_000;

	if (/^gpt-5/.test(model))
		return 400_000;

	if (/^o\d/.test(model))
		return 200_000;

	return 128_000;
}

/** Tokens of history a request for this model may carry. */
export function historyBudget(model: string): number {
	const configured = env.CONTEXT?.HISTORY_TOKENS ?? DEFAULT_HISTORY_TOKENS;
	return Math.min(configured, Math.floor(contextWindowFor(model) * WINDOW_SHARE));
}

/**
 * Rough token cost of an item: four characters a token, a flat cost per
 * image. Good enough to budget with; nothing here is billed by it.
 */
export function estimateTokens(item: ConversationItem): number {
	if (item.kind === "message") {
		return item.content.reduce((total, part) => total + (part.type === "image" ? 800 : Math.ceil(part.text.length / 4)), 4);
	}

	if (item.kind === "tool_result")
		return Math.ceil(item.output.length / 4) + 4;

	return Math.ceil(JSON.stringify(item.item).length / 4);
}

/** Whether an item opens a new turn. */
export function startsTurn(item: ConversationItem): boolean {
	return item.kind === "message" && (item.role === "user" || item.role === "developer");
}

/**
 * The history as it is sent, which is not quite how it is stored: attachment
 * URLs the CDN has stopped serving become a note (a provider rejects the whole
 * request over one dead image), and bulky tool outputs from older turns shrink
 * to a preview, since the model already answered from them.
 */
export function prepareHistory(entries: HistoryEntry[], now: number = Date.now()): ConversationItem[] {
	const lastTurn = entries.reduce((max, entry) => Math.max(max, entry.turn ?? 0), 0);

	return entries.map((entry) => {
		const item = entry.item;

		if (item.kind === "message" && now - entry.timestamp > ATTACHMENT_URL_TTL_MS && item.content.some((part) => part.type === "image")) {
			const content: MessagePart[] = item.content.map((part) => part.type === "image"
				? { type: "text", text: "[an image was attached here; it is no longer available]" }
				: part);

			return { ...item, content };
		}

		if (item.kind === "tool_result" && (entry.turn ?? 0) < lastTurn - FRESH_TURNS && item.output.length > STALE_TOOL_OUTPUT_CHARS) {
			return {
				...item,
				output: JSON.stringify({
					ok: true,
					note: "Output elided from an older turn; call the tool again if you need it.",
					preview: item.output.slice(0, 300)
				})
			};
		}

		return item;
	});
}

/** A transcript of entries for the summarizer: who said what, tool results abridged. */
export function transcript(entries: HistoryEntry[]): string {
	const lines: string[] = [];

	for (const entry of entries) {
		const item = entry.item;

		if (item.kind === "tool_result") {
			lines.push(`(tool result) ${item.output.slice(0, 300)}`);
			continue;
		}

		const text = extractItemTexts(item).join("\n").trim();
		if (!text)
			continue;

		const role = item.kind === "message" ? item.role : "assistant";
		lines.push(`${role}: ${text.slice(0, 2000)}`);
	}

	return lines.join("\n");
}
