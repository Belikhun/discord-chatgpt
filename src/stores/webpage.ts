import TurndownService from "turndown";
// @ts-expect-error turndown-plugin-gfm ships no type definitions
import turndownPluginGfm from "turndown-plugin-gfm";
import { scope } from "../logger";

const log = scope("webpage");

const FETCH_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 50;
const DEFAULT_CHUNK_LENGTH = 8000;
const MAX_CHUNK_LENGTH = 20000;

interface WebDocument {
	finalUrl: string;
	title: string | null;
	contentType: string;
	markdown: string;
	fetchedAt: number;
}

const cache = new Map<string, { fetchedAt: number; document: WebDocument }>();

const STRIP_TAGS = [
	"script", "style", "noscript", "svg", "iframe", "canvas",
	"template", "video", "audio", "object", "embed", "form",
	"select", "dialog", "nav", "footer", "aside", "header"
];

function isPrivateHost(hostname: string): boolean {
	const host = (hostname || "").toLowerCase();

	if (["localhost", "0.0.0.0", "::1", "[::1]"].includes(host))
		return true;

	// Block IPv6 literals and single-label / internal hostnames entirely.
	if (host.startsWith("[") || !host.includes("."))
		return true;

	if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan"))
		return true;

	const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (ipv4) {
		const a = Number(ipv4[1]);
		const b = Number(ipv4[2]);

		if (a === 0 || a === 10 || a === 127)
			return true;
		if (a === 169 && b === 254)
			return true;
		if (a === 172 && b >= 16 && b <= 31)
			return true;
		if (a === 192 && b === 168)
			return true;
	}

	return false;
}

function decodeEntities(text: string): string {
	return String(text || "")
		.replace(/&#(\d+);/g, (m, code) => String.fromCodePoint(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (m, code) => String.fromCodePoint(parseInt(code, 16)))
		.replaceAll("&amp;", "&")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", "\"")
		.replaceAll("&apos;", "'")
		.replaceAll("&nbsp;", " ");
}

function extractTitle(html: string): string | null {
	const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	if (!match)
		return null;

	const title = decodeEntities(match[1] as string).replace(/\s+/g, " ").trim();
	return title || null;
}

/**
 * Reduce a raw HTML document to its main content before markdown
 * conversion: strip non-content tags and prefer <main>/<article>/<body>.
 */
function cleanHtml(html: string): string {
	let output = html.replace(/<!--[\s\S]*?-->/g, "");

	// Prefer the primary content container when the page declares one.
	const main = output.match(/<main[\s>][\s\S]*<\/main>/i)
		|| output.match(/<article[\s>][\s\S]*<\/article>/i)
		|| output.match(/<body[\s>][\s\S]*<\/body>/i);

	if (main)
		output = main[0];

	for (const tag of STRIP_TAGS)
		output = output.replace(new RegExp(`<${tag}(\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, "gi"), "");

	return output;
}

/**
 * Convert cleaned HTML into compact, AI-friendly markdown. Links and images
 * are rewritten to absolute URLs; data-URI images are dropped.
 */
function convertHtmlToMarkdown(html: string, baseUrl: string): string {
	const absolute = (href: string) => {
		try {
			return new URL(href, baseUrl).toString();
		} catch {
			return href;
		}
	};

	const turndown = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
		hr: "---",
		emDelimiter: "*",

		// Nodes turndown would keep as raw HTML (e.g. complex/nested tables
		// from the gfm plugin) are flattened to their plain text instead, so
		// no raw markup leaks into the markdown output.
		keepReplacement: (content: string, node: any) => {
			const text = (node.textContent || "").replace(/\s+/g, " ").trim();
			return text ? ` ${text} ` : "";
		}
	});

	turndown.use(turndownPluginGfm.gfm);
	turndown.remove(["script", "style", "noscript", "title", "select", "option", "button"]);

	turndown.addRule("dropHiddenElements", {
		filter: (node: any) => /display\s*:\s*none/i.test(node.getAttribute?.("style") || ""),
		replacement: () => ""
	});

	turndown.addRule("compactImages", {
		filter: "img",
		replacement: (content: string, node: any) => {
			const alt = (node.getAttribute("alt") || "").trim();
			const src = node.getAttribute("src") || "";

			if (!src || src.startsWith("data:"))
				return alt ? `[image: ${alt}]` : "";

			return `![${alt}](${absolute(src)})`;
		}
	});

	turndown.addRule("absoluteLinks", {
		filter: (node: any) => node.nodeName === "A" && node.getAttribute("href"),
		replacement: (content: string, node: any) => {
			const href = node.getAttribute("href") || "";
			const text = content.trim();

			if (!text)
				return "";

			if (href.startsWith("#") || href.startsWith("javascript:"))
				return text;

			return `[${text}](${absolute(href)})`;
		}
	});

	return turndown.turndown(html)
		.replace(/[ \t]+$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
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

async function loadDocument(url: string): Promise<WebDocument> {
	log.debug(`Fetching webpage: ${url}`);
	const response = await fetch(url, {
		redirect: "follow",
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		headers: {
			"user-agent": "Mozilla/5.0 (compatible; discord-chatgpt/1.0; +https://github.com/Belikhun/discord-chatgpt)",
			"accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
			"accept-language": "en,vi;q=0.8"
		}
	});

	const finalUrl = response.url || url;

	try {
		if (isPrivateHost(new URL(finalUrl).hostname))
			throw new Error("Refusing to follow redirect to a private or local address.");
	} catch (err) {
		if (err instanceof TypeError)
			throw new Error("Failed to parse the final URL after redirects.");

		throw err;
	}

	if (!response.ok) {
		(response.body as any)?.cancel?.().catch(() => {});
		throw new Error(`Request failed with status ${response.status} ${response.statusText || ""}`.trim());
	}

	const contentType = (response.headers.get("content-type") || "").split(";")[0]!.trim().toLowerCase();
	const isHtml = !contentType || contentType.includes("html") || contentType.includes("xhtml");
	const isText = contentType.startsWith("text/")
		|| contentType.includes("json")
		|| contentType.includes("xml")
		|| contentType.includes("markdown");

	if (!isHtml && !isText) {
		(response.body as any)?.cancel?.().catch(() => {});
		throw new Error(`Unsupported content type: ${contentType || "unknown"}. Only HTML and text resources can be fetched.`);
	}

	const body = await readBodyWithLimit(response);
	let title: string | null = null;
	let markdown: string;

	if (isHtml) {
		title = extractTitle(body);
		markdown = convertHtmlToMarkdown(cleanHtml(body), finalUrl);
	} else {
		markdown = body.trim();
	}

	if (!markdown)
		throw new Error("The page returned no readable content.");

	log.debug(`Converted ${body.length} chars of ${contentType || "html"} into ${markdown.length} chars of markdown.`);

	return {
		finalUrl,
		title,
		contentType: contentType || "text/html",
		markdown,
		fetchedAt: Date.now()
	};
}

function getCachedDocument(url: string): WebDocument | null {
	const entry = cache.get(url);
	if (!entry)
		return null;

	if ((Date.now() - entry.fetchedAt) > CACHE_TTL_MS) {
		cache.delete(url);
		return null;
	}

	return entry.document;
}

function storeCachedDocument(url: string, document: WebDocument): void {
	cache.set(url, { fetchedAt: Date.now(), document });

	while (cache.size > CACHE_MAX_ENTRIES) {
		const oldest = cache.keys().next().value;
		cache.delete(oldest as string);
	}
}

/**
 * Fetch a webpage and return its content as compact markdown. Long documents
 * are cached in memory and returned in chunks: pass `startIndex` (taken from
 * the previous result's `endIndex`) to continue reading.
 */
export async function fetchWebpage(url: string, { maxLength = null, startIndex = null }: { maxLength?: number | null; startIndex?: number | null } = {}) {
	let parsed: URL;

	try {
		parsed = new URL(String(url || "").trim());
	} catch {
		return { ok: false, error: "Invalid URL. Provide an absolute http(s) URL." };
	}

	if (!["http:", "https:"].includes(parsed.protocol))
		return { ok: false, error: "Only http and https URLs are supported." };

	if (isPrivateHost(parsed.hostname))
		return { ok: false, error: "Refusing to fetch private, local or internal addresses." };

	const chunkLength = Math.max(500, Math.min(MAX_CHUNK_LENGTH, Math.floor(maxLength || DEFAULT_CHUNK_LENGTH)));
	const offset = Math.max(0, Math.floor(startIndex || 0));
	const cacheKey = parsed.toString();

	let document = getCachedDocument(cacheKey);
	const cached = Boolean(document);

	if (!document) {
		document = await loadDocument(cacheKey);
		storeCachedDocument(cacheKey, document);
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
		url: cacheKey,
		finalUrl: document.finalUrl,
		title: document.title,
		contentType: document.contentType,
		totalLength: document.markdown.length,
		startIndex: offset,
		endIndex,
		truncated,
		...(truncated ? { hint: `Content truncated. Call fetch_webpage again with startIndex=${endIndex} to continue reading.` } : {}),
		cached,
		content
	};
}
