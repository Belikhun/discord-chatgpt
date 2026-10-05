import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
// @ts-expect-error turndown-plugin-gfm ships no type definitions
import turndownPluginGfm from "turndown-plugin-gfm";
import { scope } from "../logger";
import { cleanUrl } from "./websearch";

const log = scope("webpage");

const FETCH_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 50;
const DEFAULT_CHUNK_LENGTH = 8000;
const MAX_CHUNK_LENGTH = 20000;
const MAX_OUTLINE = 40;

/** Below this much text, a Readability extract is a fragment, not the article. */
const MIN_ARTICLE_CHARS = 500;

/** ...unless it is still this share of everything readable on the page. */
const MIN_ARTICLE_SHARE = 0.3;

const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 discord-chatgpt";

export type ReadMode = "article" | "full";

export interface ReadOptions {
	maxLength?: number | null;
	startIndex?: number | null;
	/** `article` (default): the main content only. `full`: the whole page, minus chrome and junk. */
	mode?: ReadMode | null;
	/** Keep link targets (default true). Off turns links into their text. */
	links?: boolean | null;
	/** Keep images as markdown (default false). Off keeps nothing of them. */
	images?: boolean | null;
}

interface WebDocument {
	finalUrl: string;
	contentType: string;
	title: string | null;
	description: string | null;
	siteName: string | null;
	byline: string | null;
	published: string | null;
	lang: string | null;
	mode: ReadMode;
	markdown: string;
	sourceChars: number;
	fetchedAt: number;
}

const cache = new Map<string, WebDocument>();

/** Elements that never carry readable content. */
const STRIP_SELECTOR = [
	"script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "embed",
	"video", "audio", "picture source", "map", "dialog", "button", "input", "select", "textarea",
	"[hidden]", "[aria-hidden=true]", "[role=dialog]", "[role=alertdialog]", "link", "meta",
	// text meant for screen readers only ("Section titled …", "Skip to content")
	".sr-only", ".visually-hidden", ".screen-reader-text", ".a11y-hidden",
	// citation markers, edit links and navigation boxes (MediaWiki, and the many sites built like it)
	"sup.reference", ".mw-editsection", ".navbox", ".mw-jump-link", ".catlinks", ".noprint", ".printfooter"
].join(",");

/** Page chrome, removed in `full` mode (Readability drops it by itself in `article` mode). */
const CHROME_SELECTOR = "nav, footer, aside, [role=navigation], [role=banner], [role=contentinfo], [role=complementary]";

/** Class or id words that mark cookie walls, ads, share bars and other noise. */
const JUNK_PATTERN = /(^|[-_\s])(cookies?|consent|gdpr|banner|newsletter|subscribe|subscription|advert|advertisement|ads?|sponsor(ed)?|promo|popup|modal|overlay|share|sharing|social|related|recommend(ed|ations)?|breadcrumbs?|sidebar|toolbar|skip-?link|paywall|signup|login|outbrain|taboola)($|[-_\s])/i;

//* ===========================================================
//*  Address safety
//* -----------------------------------------------------------
//*  Every hop is resolved and refused on a loopback, private,
//*  link-local or otherwise internal address, so neither a
//*  hostname nor a redirect reaches the bot's own network.
//* ===========================================================

function blockedV4(address: string): boolean {
	const [a = 0, b = 0, c = 0] = address.split(".").map(Number);

	return a === 0
		|| a === 10
		|| a === 127
		|| (a === 100 && b >= 64 && b <= 127)
		|| (a === 169 && b === 254)
		|| (a === 172 && b >= 16 && b <= 31)
		|| (a === 192 && b === 0 && c === 0)
		|| (a === 192 && b === 168)
		|| (a === 198 && (b === 18 || b === 19))
		|| a >= 224;
}

/** Whether an address is one the bot must never fetch from (loopback, private, link-local, ...). */
export function blockedAddress(address: string): boolean {
	const version = isIP(address);

	if (version === 4)
		return blockedV4(address);

	if (version !== 6)
		return true;

	const lower = address.toLowerCase();
	const mapped = lower.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);

	if (mapped)
		return blockedV4(mapped[1]!);

	return lower === "::"
		|| lower === "::1"
		|| /^f[cd]/.test(lower)
		|| /^fe[89ab]/.test(lower)
		|| lower.startsWith("ff");
}

async function assertPublicHost(hostname: string): Promise<void> {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

	if (host === "localhost" || /\.(localhost|local|internal|lan|home|corp)$/.test(host))
		throw new Error("Refusing to fetch private, local or internal addresses.");

	const addresses = isIP(host)
		? [host]
		: (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

	if (addresses.length === 0 || addresses.some(blockedAddress))
		throw new Error("Refusing to fetch private, local or internal addresses.");
}

async function fetchPublic(url: URL): Promise<Response> {
	let current = url;

	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		if (!["http:", "https:"].includes(current.protocol))
			throw new Error("Only http and https URLs are supported.");

		await assertPublicHost(current.hostname);

		const response = await fetch(current, {
			redirect: "manual",
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			headers: {
				"user-agent": USER_AGENT,
				"accept": "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5",
				"accept-language": "en,vi;q=0.8"
			}
		});

		const location = response.headers.get("location");

		if (response.status >= 300 && response.status < 400 && location) {
			(response.body as any)?.cancel?.().catch(() => {});
			current = new URL(location, current);
			continue;
		}

		Object.defineProperty(response, "finalUrl", { value: current.toString() });
		return response;
	}

	throw new Error(`Gave up after ${MAX_REDIRECTS} redirects.`);
}

async function readBodyWithLimit(response: Response): Promise<string> {
	const contentType = response.headers.get("content-type") || "";
	const charsetMatch = contentType.match(/charset=([^;\s]+)/i);

	let decoder: TextDecoder;
	try {
		decoder = new TextDecoder((charsetMatch ? (charsetMatch[1] as string).trim() : "utf-8") as any);
	} catch {
		decoder = new TextDecoder();
	}

	if (!response.body)
		return "";

	const reader = response.body.getReader();
	let received = 0;
	let text = "";

	while (received < MAX_RESPONSE_BYTES) {
		const { done, value } = await reader.read();
		if (done)
			break;

		received += value.byteLength;
		text += decoder.decode(value, { stream: true });
	}

	if (received >= MAX_RESPONSE_BYTES) {
		log.warn(`Response exceeded ${MAX_RESPONSE_BYTES} bytes, truncating body.`);
		reader.cancel().catch(() => {});
	}

	return text + decoder.decode();
}

//* ===========================================================
//*  HTML → markdown
//* -----------------------------------------------------------
//*  The page is parsed into a real DOM, its noise removed, the
//*  main content picked by Readability, and only then turned
//*  into markdown, so what the model pays for is the text.
//* ===========================================================

function meta(document: any, ...names: string[]): string | null {
	for (const name of names) {
		const element = document.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
		const value = element?.getAttribute("content")?.trim();

		if (value)
			return value.replace(/\s+/g, " ");
	}

	return null;
}

function textLength(node: any): number {
	return (node?.textContent || "").replace(/\s+/g, " ").trim().length;
}

function removeNoise(root: any, { chrome }: { chrome: boolean }): void {
	for (const element of [...root.querySelectorAll(STRIP_SELECTOR)])
		element.remove();

	for (const element of [...root.querySelectorAll("[style]")]) {
		if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(element.getAttribute("style") || ""))
			element.remove();
	}

	if (!chrome)
		return;

	for (const element of [...root.querySelectorAll(CHROME_SELECTOR)])
		element.remove();

	const total = Math.max(1, textLength(root));

	for (const element of [...root.querySelectorAll("[class], [id]")]) {
		if (!element.isConnected)
			continue;

		const marker = `${element.getAttribute("class") || ""} ${element.getAttribute("id") || ""}`;
		if (!JUNK_PATTERN.test(marker))
			continue;

		// A wrapper named after one of these words can hold the whole page
		// (`<body class="has-sidebar">`); only drop what is clearly a part.
		if (element.querySelector("main, article, [role=main]") || textLength(element) > total * 0.5)
			continue;

		element.remove();
	}
}

function markdownConverter(baseUrl: string, { links, images }: { links: boolean; images: boolean }): TurndownService {
	let pageHost = "";

	try {
		pageHost = new URL(baseUrl).host;
	} catch {
		// an unparseable base only costs the shortening below
	}

	const absolute = (href: string) => {
		try {
			return cleanUrl(new URL(href, baseUrl).toString());
		} catch {
			return href;
		}
	};

	// A link within the same site is written as its path: the page's own URL
	// is in the result, and the host repeated on every link is pure cost.
	const compact = (href: string) => {
		const target = absolute(href);

		try {
			const url = new URL(target);
			return url.host === pageHost ? `${url.pathname}${url.search}` : target;
		} catch {
			return target;
		}
	};

	const turndown = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
		hr: "---",
		emDelimiter: "*",

		// Nodes turndown would keep as raw HTML (complex tables, mostly) are
		// flattened to their text, so no markup reaches the model.
		keepReplacement: (content: string, node: any) => {
			const text = (node.textContent || "").replace(/\s+/g, " ").trim();
			return text ? ` ${text} ` : "";
		}
	});

	turndown.use(turndownPluginGfm.gfm);
	turndown.remove(["script", "style", "noscript", "title", "select", "option", "button", "form"] as any);

	turndown.addRule("images", {
		filter: "img",
		replacement: (content: string, node: any) => {
			if (!images)
				return "";

			const alt = (node.getAttribute("alt") || "").trim();
			const src = node.getAttribute("src") || "";

			if (!src || src.startsWith("data:"))
				return "";

			return `![${alt}](${absolute(src)})`;
		}
	});

	turndown.addRule("links", {
		filter: (node: any) => node.nodeName === "A",
		replacement: (content: string, node: any) => {
			const text = content.replace(/\s+/g, " ").trim();
			const href = node.getAttribute("href") || "";

			if (!text)
				return "";

			if (!links || !href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:"))
				return text;

			const target = compact(href);
			const full = absolute(href);
			const bare = text === full || (/^https?:/i.test(href) && text === href);

			return bare ? `<${full}>` : `[${text}](${target})`;
		}
	});

	return turndown;
}

/**
 * Tables used for layout (no header cell anywhere, or one nested in another)
 * are not data: markdown cannot hold them, and flattened whole they run every
 * cell into one line. Turned into plain blocks they read row by row.
 */
function unwrapLayoutTables(html: string): string {
	const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
	const tables = [...document.querySelectorAll("table")].reverse();
	let changed = false;

	for (const table of tables) {
		const layout = !table.querySelector("th")
			|| Boolean(table.querySelector("table"))
			|| table.getAttribute("role") === "presentation";

		if (!layout)
			continue;

		for (const cell of [...table.querySelectorAll("td, th")]) {
			const span = document.createElement("span");
			span.innerHTML = `${cell.innerHTML} `;
			cell.replaceWith(span);
		}

		for (const block of [...table.querySelectorAll("tr, tbody, thead, tfoot, caption")]) {
			const div = document.createElement("div");
			div.innerHTML = block.innerHTML;
			block.replaceWith(div);
		}

		const wrapper = document.createElement("div");
		wrapper.innerHTML = table.innerHTML;
		table.replaceWith(wrapper);
		changed = true;
	}

	return changed ? document.body.innerHTML : html;
}

/** Tidy converted markdown: no trailing spaces, no empty link or list lines, no repeated lines, no blank runs. */
function tidy(markdown: string): string {
	const output: string[] = [];
	let fenced = false;

	for (const raw of markdown.split("\n")) {
		const line = raw.replace(/[ \t]+$/, "");

		if (line.startsWith("```"))
			fenced = !fenced;

		if (!fenced) {
			if (/^\s*([-*+]|\d+\.)\s*$/.test(line) || /^\s*\[\]\([^)]*\)\s*$/.test(line))
				continue;

			if (line.trim() && output.length > 0 && output[output.length - 1] === line)
				continue;
		}

		output.push(line);
	}

	return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** HTML to compact markdown plus page metadata; exported for tests. */
export function convertHtml(html: string, baseUrl: string, options: { mode: ReadMode; links: boolean; images: boolean }) {
	const { document } = parseHTML(html);
	const turndown = markdownConverter(baseUrl, options);

	const metadata = {
		title: meta(document, "og:title", "twitter:title") || (document.querySelector("title")?.textContent || "").replace(/\s+/g, " ").trim() || null,
		description: meta(document, "description", "og:description", "twitter:description"),
		siteName: meta(document, "og:site_name", "application-name"),
		published: meta(document, "article:published_time", "datePublished", "date")
			|| document.querySelector("time[datetime]")?.getAttribute("datetime")
			|| null,
		lang: document.documentElement?.getAttribute("lang") || null,
		byline: null as string | null
	};

	removeNoise(document, { chrome: false });

	let mode = options.mode;
	let body = "";

	if (mode === "article") {
		// Readability rewrites the document it reads, so it gets its own copy.
		const { document: copy } = parseHTML(document.toString());
		const article = new Readability(copy as any, { charThreshold: 200, keepClasses: false }).parse();
		const pageText = Math.max(1, textLength(document.body));
		const articleText = (article?.textContent || "").replace(/\s+/g, " ").trim().length;

		if (article?.content && (articleText >= MIN_ARTICLE_CHARS || articleText >= pageText * MIN_ARTICLE_SHARE)) {
			body = article.content;
			metadata.byline = article.byline?.trim() || null;
			metadata.title = metadata.title || article.title || null;
		} else {
			mode = "full";
		}
	}

	if (mode === "full") {
		removeNoise(document, { chrome: true });
		const root = document.querySelector("main, [role=main]") || document.body || document.documentElement;
		body = root?.innerHTML || html;
	}

	return { ...metadata, mode, markdown: tidy(turndown.turndown(unwrapLayoutTables(body || ""))) };
}

/** The document's headings and where each starts, so a long page can be read section by section. */
function outline(markdown: string): { level: number; title: string; startIndex: number }[] {
	const headings: { level: number; title: string; startIndex: number }[] = [];
	let offset = 0;
	let fenced = false;

	for (const line of markdown.split("\n")) {
		if (line.startsWith("```"))
			fenced = !fenced;

		const match = !fenced && line.match(/^(#{1,4})\s+(.+)$/);

		if (match)
			headings.push({ level: match[1]!.length, title: match[2]!.replace(/[*_`[\]]/g, "").replace(/\(([^)]*)\)/g, "").trim().slice(0, 120), startIndex: offset });

		offset += line.length + 1;
	}

	return headings.slice(0, MAX_OUTLINE);
}

async function loadDocument(url: URL, options: { mode: ReadMode; links: boolean; images: boolean }): Promise<WebDocument> {
	log.debug(`Fetching webpage: ${url}`);

	const response = await fetchPublic(url);
	const finalUrl: string = (response as any).finalUrl || url.toString();

	if (!response.ok) {
		(response.body as any)?.cancel?.().catch(() => {});
		throw new Error(`Request failed with status ${response.status} ${response.statusText || ""}`.trim());
	}

	const contentType = (response.headers.get("content-type") || "").split(";")[0]!.trim().toLowerCase();
	const isHtml = !contentType || contentType.includes("html") || contentType.includes("xhtml");
	const isJson = contentType.includes("json");
	const isText = contentType.startsWith("text/") || isJson || contentType.includes("xml") || contentType.includes("markdown");

	if (!isHtml && !isText) {
		(response.body as any)?.cancel?.().catch(() => {});
		throw new Error(`Unsupported content type: ${contentType || "unknown"}. Only HTML, JSON and text resources can be read.`);
	}

	const body = await readBodyWithLimit(response);
	const base = {
		finalUrl,
		contentType: contentType || "text/html",
		sourceChars: body.length,
		fetchedAt: Date.now()
	};

	if (!isHtml) {
		let markdown = body.trim();

		if (isJson) {
			try {
				markdown = JSON.stringify(JSON.parse(body), null, 1);
			} catch {
				// served as JSON, is not; keep the text
			}
		}

		return { ...base, title: null, description: null, siteName: null, byline: null, published: null, lang: null, mode: "full", markdown };
	}

	const converted = convertHtml(body, finalUrl, options);

	if (!converted.markdown)
		throw new Error("The page returned no readable content (it may need JavaScript to render).");

	log.debug(`Read ${body.length} chars of HTML as ${converted.markdown.length} chars of markdown (${converted.mode}).`);

	return { ...base, ...converted };
}

function cacheKey(url: string, options: { mode: ReadMode; links: boolean; images: boolean }): string {
	return `${options.mode}|${options.links ? 1 : 0}|${options.images ? 1 : 0}|${url}`;
}

function getCachedDocument(key: string): WebDocument | null {
	const document = cache.get(key);
	if (!document)
		return null;

	if ((Date.now() - document.fetchedAt) > CACHE_TTL_MS) {
		cache.delete(key);
		return null;
	}

	return document;
}

function storeCachedDocument(key: string, document: WebDocument): void {
	cache.set(key, document);

	while (cache.size > CACHE_MAX_ENTRIES)
		cache.delete(cache.keys().next().value as string);
}

/**
 * Read a webpage as compact markdown: the main content by default, without
 * scripts, chrome, cookie walls, ads or images. Long documents are cached and
 * returned in chunks: pass `startIndex` (the previous result's `endIndex`, or
 * a heading's offset from `outline`) to continue reading.
 */
export async function fetchWebpage(url: string, options: ReadOptions = {}) {
	let parsed: URL;

	try {
		parsed = new URL(String(url || "").trim());
	} catch {
		return { ok: false, error: "Invalid URL. Provide an absolute http(s) URL." };
	}

	if (!["http:", "https:"].includes(parsed.protocol))
		return { ok: false, error: "Only http and https URLs are supported." };

	const settings = {
		mode: (options.mode === "full" ? "full" : "article") as ReadMode,
		links: options.links !== false,
		images: options.images === true
	};
	const chunkLength = Math.max(500, Math.min(MAX_CHUNK_LENGTH, Math.floor(options.maxLength || DEFAULT_CHUNK_LENGTH)));
	const offset = Math.max(0, Math.floor(options.startIndex || 0));
	const key = cacheKey(parsed.toString(), settings);

	let document = getCachedDocument(key);
	const cached = Boolean(document);

	if (!document) {
		try {
			document = await loadDocument(parsed, settings);
		} catch (err: any) {
			return { ok: false, error: err?.message || String(err) };
		}

		storeCachedDocument(key, document);
	}

	if (offset >= document.markdown.length && document.markdown.length > 0) {
		return {
			ok: false,
			error: `startIndex ${offset} is past the end of the document (totalLength ${document.markdown.length}).`
		};
	}

	const content = document.markdown.slice(offset, offset + chunkLength);
	const endIndex = offset + content.length;
	const truncated = endIndex < document.markdown.length;

	return {
		ok: true,
		url: parsed.toString(),
		finalUrl: document.finalUrl,
		title: document.title,
		...(document.description ? { description: document.description } : {}),
		...(document.siteName ? { siteName: document.siteName } : {}),
		...(document.byline ? { byline: document.byline } : {}),
		...(document.published ? { published: document.published } : {}),
		...(document.lang ? { lang: document.lang } : {}),
		contentType: document.contentType,
		mode: document.mode,
		totalLength: document.markdown.length,
		startIndex: offset,
		endIndex,
		truncated,
		...(truncated && offset === 0 ? { outline: outline(document.markdown) } : {}),
		...(truncated ? { hint: `Content truncated. Call fetch_webpage again with startIndex=${endIndex} to continue, or jump to a heading's startIndex from outline.` } : {}),
		cached,
		content
	};
}
