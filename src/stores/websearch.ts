import { env, getProviderConfig, listConfiguredProviderIds } from "../env";
import { scope } from "../logger";

const log = scope("websearch");

const SEARCH_TIMEOUT_MS = 30_000;
const DEFAULT_COUNT = 6;
const MAX_COUNT = 10;
const MAX_SNIPPET = 320;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 100;

export type WebSearchProvider = "openai" | "gemini" | "brave" | "tavily" | "searxng" | "google";

/**
 * The web_search backend. Keyless scraping of a public engine is not offered:
 * every engine serves a bot challenge to a datacenter address, so results
 * would come and go. Without a search API configured, the search runs through
 * a chat provider's own web search (OpenAI's web_search tool, Gemini's Google
 * Search grounding), which needs only the key the bot already has.
 */
export interface WebSearchConfig {
	/**
	 * Default: searxng when URL is set, google when API_KEY and ENGINE_ID are,
	 * else openai, else gemini. brave and tavily are only used when named here.
	 */
	PROVIDER?: WebSearchProvider;

	/** brave, tavily or google. */
	API_KEY?: string;

	/** searxng: the instance's base URL (its JSON format must be enabled). */
	URL?: string;

	/** google: the Programmable Search Engine id (cx). */
	ENGINE_ID?: string;

	/** openai or gemini: the model that runs the search. */
	MODEL?: string;

	/** Two-letter country and language hints, where the backend takes them. */
	COUNTRY?: string;
	LANGUAGE?: string;
}

export type Freshness = "day" | "week" | "month" | "year";

export interface SearchOptions {
	count?: number | null;
	freshness?: Freshness | null;
	site?: string | null;
}

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	published?: string;
}

export interface SearchOutcome {
	provider: WebSearchProvider;
	results: SearchResult[];
	/** openai/gemini: the engine's own short answer, citations stripped. */
	summary?: string;
}

const cache = new Map<string, { at: number; outcome: SearchOutcome }>();

/** Query parameters that only track the click. */
const TRACKING_PARAM = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|ref_src|srsltid)$/i;

/** A URL without tracking parameters, so the same page is never listed twice. */
export function cleanUrl(raw: string): string {
	try {
		const url = new URL(raw);

		for (const key of [...url.searchParams.keys()]) {
			if (TRACKING_PARAM.test(key))
				url.searchParams.delete(key);
		}

		url.hash = "";
		return url.toString();
	} catch {
		return raw;
	}
}

function plain(text: string | null | undefined): string {
	return String(text ?? "")
		.replace(/<[^>]+>/g, "")
		.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
		.replaceAll("&amp;", "&")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", "\"")
		.replaceAll("&#39;", "'")
		.replaceAll("&nbsp;", " ")
		.replace(/\s+/g, " ")
		.trim();
}

function clip(text: string, max = MAX_SNIPPET): string {
	return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function settings(): WebSearchConfig {
	return env.WEB_SEARCH ?? {};
}

/** Which backend runs a search, by the rule in {@link WebSearchConfig.PROVIDER}. */
export function activeSearchProvider(): WebSearchProvider | null {
	const config = settings();

	if (config.PROVIDER)
		return config.PROVIDER;

	if (config.URL)
		return "searxng";

	if (config.API_KEY && config.ENGINE_ID)
		return "google";

	const providers = listConfiguredProviderIds();

	if (providers.includes("openai"))
		return "openai";

	if (providers.includes("gemini"))
		return "gemini";

	return null;
}

async function getJson(url: string, init: RequestInit = {}): Promise<any> {
	const response = await fetch(url, { ...init, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
	const text = await response.text();

	if (!response.ok)
		throw new Error(`search backend answered ${response.status}: ${plain(text).slice(0, 200)}`);

	return JSON.parse(text);
}

/** Restrictions the API backends cannot take as parameters, written into the query. */
function decoratedQuery(query: string, options: SearchOptions): string {
	return options.site ? `${query} site:${options.site}` : query;
}

/** Inline citation markers OpenAI writes into the text: `([site](url))`. */
const CITATION_MARKER = /\s*\(\[[^\]]*\]\([^)]*\)\)/g;

/** The sentence a citation at `index` backs: from the previous sentence end (or citation) up to it. */
function citedSentence(text: string, index: number): string {
	const prefix = text.slice(0, index).replace(/\s+$/, "");
	const boundary = Math.max(
		prefix.lastIndexOf(". ", prefix.length - 2),
		prefix.lastIndexOf("! ", prefix.length - 2),
		prefix.lastIndexOf("? ", prefix.length - 2),
		prefix.lastIndexOf(")) "),
		prefix.lastIndexOf("\n")
	);

	return clip(plain(prefix.slice(boundary + 1).replace(CITATION_MARKER, "").replace(/^[)\s.!?]+/, "")));
}

async function searchOpenAI(query: string, options: SearchOptions, count: number): Promise<SearchOutcome> {
	const provider = getProviderConfig("openai");
	if (!provider)
		throw new Error("the openai provider is not configured");

	const base = (provider.BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
	const config = settings();
	const restrictions = [
		options.site ? `Only use results from ${options.site}.` : "",
		options.freshness ? `Only use results published within the past ${options.freshness}.` : ""
	].filter(Boolean).join(" ");

	const body = {
		model: config.MODEL || "gpt-4.1-mini",
		tools: [{
			type: "web_search",
			...(config.COUNTRY ? { user_location: { type: "approximate", country: config.COUNTRY } } : {})
		}],
		tool_choice: "required",
		include: ["web_search_call.action.sources"],
		instructions: `You are a search engine. Search the web for the user's query and answer in at most four sentences, citing a source for every claim. ${restrictions}`.trim(),
		input: decoratedQuery(query, options)
	};

	const response = await getJson(`${base}/responses`, {
		method: "POST",
		headers: {
			"authorization": `Bearer ${provider.API_KEY}`,
			"content-type": "application/json"
		},
		body: JSON.stringify(body)
	});

	const results = new Map<string, SearchResult>();
	let summary = "";

	for (const item of response.output ?? []) {
		if (item.type !== "message")
			continue;

		for (const part of item.content ?? []) {
			const text: string = part.text ?? "";
			summary += text;

			for (const annotation of part.annotations ?? []) {
				if (annotation.type !== "url_citation")
					continue;

				const url = cleanUrl(annotation.url);
				const cited = text.slice(annotation.start_index, annotation.end_index);
				const sentence = citedSentence(text, annotation.start_index);
				const existing = results.get(url);

				if (existing) {
					if (sentence && !existing.snippet.includes(sentence))
						existing.snippet = clip(`${existing.snippet} ${sentence}`);

					continue;
				}

				results.set(url, { title: plain(annotation.title) || cited, url, snippet: clip(sentence) });
			}
		}
	}

	// Sources the engine read but did not cite still count, after the cited ones.
	for (const item of response.output ?? []) {
		if (item.type !== "web_search_call")
			continue;

		for (const source of item.action?.sources ?? []) {
			const url = cleanUrl(source.url);

			if (!results.has(url))
				results.set(url, { title: new URL(url).hostname, url, snippet: "" });
		}
	}

	return {
		provider: "openai",
		results: [...results.values()].slice(0, count),
		summary: clip(plain(summary.replace(CITATION_MARKER, "")), 900)
	};
}

/** Gemini's grounding links are redirects through Google; resolve them to the page. */
async function resolveRedirect(url: string): Promise<string> {
	try {
		const response = await fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(5_000) });
		const location = response.headers.get("location");
		return location ? cleanUrl(location) : url;
	} catch {
		return url;
	}
}

async function searchGemini(query: string, options: SearchOptions, count: number): Promise<SearchOutcome> {
	const provider = getProviderConfig("gemini");
	if (!provider)
		throw new Error("the gemini provider is not configured");

	const base = (provider.BASE_URL || "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
	const model = settings().MODEL || "gemini-2.5-flash";
	const freshness = options.freshness ? ` Only use results published within the past ${options.freshness}.` : "";

	const response = await getJson(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
		method: "POST",
		headers: {
			"x-goog-api-key": provider.API_KEY,
			"content-type": "application/json"
		},
		body: JSON.stringify({
			contents: [{ role: "user", parts: [{ text: `Search the web and answer in at most four sentences: ${decoratedQuery(query, options)}${freshness}` }] }],
			tools: [{ google_search: {} }]
		})
	});

	const candidate = response.candidates?.[0];
	const metadata = candidate?.groundingMetadata ?? {};
	const chunks: any[] = metadata.groundingChunks ?? [];
	const snippets = new Map<number, string>();

	for (const support of metadata.groundingSupports ?? []) {
		for (const index of support.groundingChunkIndices ?? []) {
			const text = plain(support.segment?.text);
			snippets.set(index, clip(snippets.has(index) ? `${snippets.get(index)} ${text}` : text));
		}
	}

	const picked = chunks.slice(0, count);
	const urls = await Promise.all(picked.map((chunk) => resolveRedirect(chunk.web?.uri ?? "")));
	const results: SearchResult[] = picked.map((chunk, index) => ({
		title: plain(chunk.web?.title) || new URL(urls[index]!).hostname,
		url: urls[index]!,
		snippet: snippets.get(index) ?? ""
	}));

	const summary = (candidate?.content?.parts ?? []).map((part: any) => part.text ?? "").join("");

	return { provider: "gemini", results, summary: clip(plain(summary), 900) };
}

const BRAVE_FRESHNESS: Record<Freshness, string> = { day: "pd", week: "pw", month: "pm", year: "py" };

async function searchBrave(query: string, options: SearchOptions, count: number): Promise<SearchOutcome> {
	const config = settings();
	const params = new URLSearchParams({ q: decoratedQuery(query, options), count: String(count), text_decorations: "false" });

	if (options.freshness)
		params.set("freshness", BRAVE_FRESHNESS[options.freshness]);

	if (config.COUNTRY)
		params.set("country", config.COUNTRY);

	if (config.LANGUAGE)
		params.set("search_lang", config.LANGUAGE);

	const response = await getJson(`https://api.search.brave.com/res/v1/web/search?${params}`, {
		headers: { "accept": "application/json", "x-subscription-token": config.API_KEY ?? "" }
	});

	return {
		provider: "brave",
		results: (response.web?.results ?? []).map((result: any) => ({
			title: plain(result.title),
			url: cleanUrl(result.url),
			snippet: clip(plain([result.description, ...(result.extra_snippets ?? [])].join(" "))),
			published: result.page_age || result.age || undefined
		}))
	};
}

async function searchTavily(query: string, options: SearchOptions, count: number): Promise<SearchOutcome> {
	const config = settings();

	const response = await getJson("https://api.tavily.com/search", {
		method: "POST",
		headers: { "authorization": `Bearer ${config.API_KEY ?? ""}`, "content-type": "application/json" },
		body: JSON.stringify({
			query,
			max_results: count,
			search_depth: "basic",
			...(options.freshness ? { time_range: options.freshness } : {}),
			...(options.site ? { include_domains: [options.site] } : {})
		})
	});

	return {
		provider: "tavily",
		results: (response.results ?? []).map((result: any) => ({
			title: plain(result.title),
			url: cleanUrl(result.url),
			snippet: clip(plain(result.content)),
			published: result.published_date || undefined
		}))
	};
}

async function searchSearxng(query: string, options: SearchOptions, count: number): Promise<SearchOutcome> {
	const config = settings();
	const params = new URLSearchParams({ q: decoratedQuery(query, options), format: "json" });

	if (options.freshness)
		params.set("time_range", options.freshness);

	if (config.LANGUAGE)
		params.set("language", config.LANGUAGE);

	const response = await getJson(`${(config.URL ?? "").replace(/\/+$/, "")}/search?${params}`);

	return {
		provider: "searxng",
		results: (response.results ?? []).slice(0, count).map((result: any) => ({
			title: plain(result.title),
			url: cleanUrl(result.url),
			snippet: clip(plain(result.content)),
			published: result.publishedDate || undefined
		}))
	};
}

const GOOGLE_FRESHNESS: Record<Freshness, string> = { day: "d1", week: "w1", month: "m1", year: "y1" };

async function searchGoogle(query: string, options: SearchOptions, count: number): Promise<SearchOutcome> {
	const config = settings();
	const params = new URLSearchParams({
		key: config.API_KEY ?? "",
		cx: config.ENGINE_ID ?? "",
		q: decoratedQuery(query, options),
		num: String(Math.min(10, count))
	});

	if (options.freshness)
		params.set("dateRestrict", GOOGLE_FRESHNESS[options.freshness]);

	if (config.LANGUAGE)
		params.set("lr", `lang_${config.LANGUAGE}`);

	const response = await getJson(`https://www.googleapis.com/customsearch/v1?${params}`);

	return {
		provider: "google",
		results: (response.items ?? []).map((item: any) => ({
			title: plain(item.title),
			url: cleanUrl(item.link),
			snippet: clip(plain(item.snippet))
		}))
	};
}

const BACKENDS: Record<WebSearchProvider, (query: string, options: SearchOptions, count: number) => Promise<SearchOutcome>> = {
	openai: searchOpenAI,
	gemini: searchGemini,
	brave: searchBrave,
	tavily: searchTavily,
	searxng: searchSearxng,
	google: searchGoogle
};

/** Search the web; results are deduplicated by URL (tracking parameters ignored) and cached briefly. */
export async function webSearch(query: string, options: SearchOptions = {}): Promise<SearchOutcome> {
	const provider = activeSearchProvider();
	if (!provider)
		throw new Error("no web search backend is configured");

	const count = Math.max(1, Math.min(MAX_COUNT, Math.floor(options.count || DEFAULT_COUNT)));
	const key = JSON.stringify([provider, query.trim().toLowerCase(), count, options.freshness ?? null, options.site ?? null]);
	const cached = cache.get(key);

	if (cached && Date.now() - cached.at < CACHE_TTL_MS)
		return cached.outcome;

	log.debug(`Searching ${provider} for "${query}"`);
	const outcome = await BACKENDS[provider](query.trim(), options, count);

	const seen = new Set<string>();
	outcome.results = outcome.results.filter((result) => {
		if (!result.url || seen.has(result.url))
			return false;

		seen.add(result.url);
		return true;
	});

	cache.set(key, { at: Date.now(), outcome });

	while (cache.size > CACHE_MAX_ENTRIES)
		cache.delete(cache.keys().next().value as string);

	return outcome;
}
