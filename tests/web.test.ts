import { describe, expect, test } from "bun:test";
import { blockedAddress, convertHtml } from "../src/stores/webpage";
import { cleanUrl } from "../src/stores/websearch";

describe("address safety", () => {
	test("internal addresses are refused, public ones allowed", () => {
		for (const address of ["127.0.0.1", "10.0.0.10", "172.20.1.1", "192.168.1.5", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "224.0.0.1"])
			expect(blockedAddress(address)).toBe(true);

		for (const address of ["1.1.1.1", "142.250.72.14", "2606:4700:4700::1111"])
			expect(blockedAddress(address)).toBe(false);
	});
});

describe("search urls", () => {
	test("tracking parameters and fragments are dropped", () => {
		expect(cleanUrl("https://papermc.io/news/1-21-11/?utm_source=openai&x=1#top")).toBe("https://papermc.io/news/1-21-11/?x=1");
	});
});

describe("html to markdown", () => {
	const page = `<!doctype html><html lang="en"><head><title>Release notes</title><meta name="description" content="What changed"></head><body>
		<nav><a href="/">Home</a><a href="/docs">Docs</a></nav>
		<div class="cookie-banner">We use cookies <button>Accept</button></div>
		<main><article><h1>Release 1.2</h1>
			<p>This release fixes the <a href="/bugs/42?utm_source=x">crash on join</a> and adds <a href="https://other.site/page">an integration</a>.</p>
			<p><img src="/shot.png" alt="screenshot"><span class="sr-only">Section titled release</span>Plenty of text to make this read as an article rather than a fragment of a page. ${"More words about the release. ".repeat(30)}</p>
			<script>tracker()</script>
		</article></main>
		<footer>© someone</footer></body></html>`;

	test("article mode keeps the content, drops chrome, images and junk, shortens same-site links", () => {
		const result = convertHtml(page, "https://example.com/notes", { mode: "article", links: true, images: false });

		expect(result.mode).toBe("article");
		expect(result.title).toBe("Release notes");
		expect(result.description).toBe("What changed");
		expect(result.markdown).toContain("[crash on join](/bugs/42)");
		expect(result.markdown).toContain("[an integration](https://other.site/page)");
		expect(result.markdown).not.toContain("cookies");
		expect(result.markdown).not.toContain("tracker");
		expect(result.markdown).not.toContain("shot.png");
		expect(result.markdown).not.toContain("Section titled");
	});

	test("links can be dropped to their text", () => {
		const result = convertHtml(page, "https://example.com/notes", { mode: "article", links: false, images: false });
		expect(result.markdown).toContain("fixes the crash on join and");
	});

	test("layout tables read row by row instead of running together", () => {
		const layout = `<html><body><table><tr><td><a href="/a">First story</a></td><td>12 points</td></tr><tr><td><a href="/b">Second story</a></td><td>3 points</td></tr></table></body></html>`;
		const result = convertHtml(layout, "https://news.example/", { mode: "full", links: true, images: false });
		const lines = result.markdown.split("\n").filter(Boolean);

		expect(lines[0]).toContain("[First story](/a)");
		expect(lines[0]).toContain("12 points");
		expect(lines[1]).toContain("[Second story](/b)");
	});
});
