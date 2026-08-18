import fs from "node:fs";
import path from "node:path";
import { scope } from "../logger";

const log = scope("minecraft-wiki");
const API_URL = "https://minecraft.wiki/api.php";
const cacheDir = path.join(process.cwd(), "data", "minecraft_wiki");

interface PageRef {
	pageId?: number | null;
	title?: string | null;
}

interface CachedPage {
	pageId: number | null;
	title: string | null;
	content: string;
	fetchedAt: number;
}

function ensureCacheDir(): void {
	if (!fs.existsSync(cacheDir))
		fs.mkdirSync(cacheDir, { recursive: true });
}

function sanitizeTitle(title?: string | null): string {
	return encodeURIComponent(title || "").replace(/%/g, "_");
}

function cacheFilePath({ pageId, title }: PageRef): string {
	if (pageId)
		return path.join(cacheDir, `page-${pageId}.json`);

	return path.join(cacheDir, `title-${sanitizeTitle(title)}.json`);
}

function readCache(ref: PageRef): CachedPage | null {
	ensureCacheDir();
	const filePath = cacheFilePath(ref);
	if (!fs.existsSync(filePath))
		return null;

	try {
		const raw = fs.readFileSync(filePath, "utf8");
		return JSON.parse(raw || "null");
	} catch (err: any) {
		log.warn(`Failed to read cache ${filePath}: ${err.message}`);
		return null;
	}
}

function writeCache(ref: PageRef, payload: CachedPage): void {
	ensureCacheDir();
	const filePath = cacheFilePath(ref);
	fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function normalizeContent(text: string | null | undefined): string {
	return String(text || "").replace(/\r\n/g, "\n");
}

async function fetchJson(params: URLSearchParams): Promise<any> {
	const url = `${API_URL}?${params.toString()}`;
	const response = await fetch(url);
	if (!response.ok)
		throw new Error(`Minecraft wiki request failed: ${response.status}`);

	return await response.json();
}

export async function searchWiki(query: string, { limit }: { limit?: number | null } = {}) {
	const needle = String(query || "").trim();
	if (!needle)
		return { ok: false, error: "Search query cannot be empty." };

	const max = Math.max(1, Math.min(25, Math.floor(limit || 10)));
	const params = new URLSearchParams({
		action: "query",
		list: "search",
		srsearch: needle,
		srlimit: String(max),
		format: "json"
	});

	const data = await fetchJson(params);
	const items = (data?.query?.search || []).map((item: any) => ({
		pageId: item.pageid,
		title: item.title,
		snippet: item.snippet,
		wordcount: item.wordcount,
		timestamp: item.timestamp
	}));

	return { ok: true, count: items.length, items };
}

export async function fetchWikiPage({ pageId, title }: PageRef) {
	if (!pageId && !title)
		return { ok: false as const, error: "Page title or pageId is required." };

	const cached = readCache({ pageId, title });
	if (cached?.content)
		return { ok: true as const, page: cached, cached: true };

	const params = new URLSearchParams({
		action: "parse",
		prop: "wikitext",
		format: "json"
	});
	if (pageId)
		params.set("pageid", String(pageId));
	else
		params.set("page", String(title));

	const data = await fetchJson(params);
	const pageTitle = data?.parse?.title || title || null;
	const resolvedPageId = data?.parse?.pageid || pageId || null;
	const content = normalizeContent(data?.parse?.wikitext?.["*"] || "");
	if (!content)
		return { ok: false as const, error: "Failed to load wiki page content." };

	const payload: CachedPage = {
		pageId: resolvedPageId,
		title: pageTitle,
		content,
		fetchedAt: Date.now()
	};

	writeCache({ pageId: resolvedPageId, title: pageTitle }, payload);
	return { ok: true as const, page: payload, cached: false };
}

export async function searchWikiContent({ pageId, title, query, limit }: PageRef & { query?: string | null; limit?: number | null } = {}) {
	const needle = String(query || "").trim();
	if (!needle)
		return { ok: false, error: "Search query cannot be empty." };

	const pageResult = await fetchWikiPage({ pageId, title });
	if (!pageResult.ok)
		return pageResult;

	const content = normalizeContent(pageResult.page.content);
	const lines = content.split("\n");
	const max = Math.max(1, Math.min(200, Math.floor(limit || 20)));
	const lowerNeedle = needle.toLowerCase();

	const matches: { lineNumber: number; line: string }[] = [];
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		if (!line)
			continue;

		if (line.toLowerCase().includes(lowerNeedle)) {
			matches.push({ lineNumber: i + 1, line });
			if (matches.length >= max)
				break;
		}
	}

	return {
		ok: true,
		page: { pageId: pageResult.page.pageId, title: pageResult.page.title },
		count: matches.length,
		items: matches
	};
}

export async function readWikiContent({ pageId, title, startLine, endLine }: PageRef & { startLine?: number | null; endLine?: number | null } = {}) {
	const pageResult = await fetchWikiPage({ pageId, title });
	if (!pageResult.ok)
		return pageResult;

	const content = normalizeContent(pageResult.page.content);
	const lines = content.split("\n");
	const totalLines = lines.length;
	const start = Math.max(1, Math.floor(startLine || 1));
	const end = Math.max(start, Math.min(totalLines, Math.floor(endLine || start)));

	const slice = lines.slice(start - 1, end);
	return {
		ok: true,
		page: { pageId: pageResult.page.pageId, title: pageResult.page.title },
		startLine: start,
		endLine: end,
		totalLines,
		content: slice.join("\n")
	};
}
