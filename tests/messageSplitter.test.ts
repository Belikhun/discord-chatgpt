import { describe, expect, test } from "bun:test";
import {
	MESSAGE_MAX_LENGTH,
	breakAndFixMessage,
	breakMessage,
	checkClosingBlocks
} from "../src/conversation/messageSplitter";

describe("checkClosingBlocks", () => {
	test("plain text is not inside any block", () => {
		expect(checkClosingBlocks("hello world")).toEqual({
			isInCode: false,
			isInCodeblock: false,
			codeblockHeader: null
		});
	});

	test("odd number of code fences means an open codeblock, header captured", () => {
		const state = checkClosingBlocks("intro\n```js\nconst a = 1;");
		expect(state.isInCodeblock).toBe(true);
		// The multiline $ alternative matches before the newline, so the
		// captured header carries no trailing newline.
		expect(state.codeblockHeader).toBe("```js");
	});

	test("even number of code fences means the codeblock is closed", () => {
		const state = checkClosingBlocks("```js\nconst a = 1;\n```\ndone");
		expect(state.isInCodeblock).toBe(false);
		expect(state.codeblockHeader).toBe(null);
	});

	test("odd inline backticks means open inline code", () => {
		expect(checkClosingBlocks("this is `broken inline").isInCode).toBe(true);
	});

	test("balanced inline backticks are closed", () => {
		expect(checkClosingBlocks("some `code` here").isInCode).toBe(false);
	});
});

describe("breakMessage", () => {
	test("plan 1: breaks at the last newline before the limit", () => {
		const message = "line one\nline two\nline three";
		const [head, tail] = breakMessage(message, 15);
		expect(head).toBe("line one");
		expect(tail).toBe("line two\nline three");
	});

	test("plan 2: accumulates sentences when there is no usable newline", () => {
		const message = "First sentence. Second sentence. Third sentence.";
		const [head, tail] = breakMessage(message, 35);
		expect(head).toBe("First sentence. Second sentence.");
		expect(tail).toBe("Third sentence.");
	});

	test("plan 2 quirk: an unbreakable blob yields a bare '.' head (original behavior)", () => {
		// No newline and no ". " separator: plan 2 fires on its first
		// iteration with an empty accumulator, producing "." as the head and
		// the whole blob as the tail. Quirky, but this is what the
		// pre-refactor code did — preserved verbatim.
		const message = "x".repeat(100);
		const [head, tail] = breakMessage(message, 50);
		expect(head).toBe(".");
		expect(tail).toBe(message);
	});

	test("plan 3: content already within the limit passes through as [message, '']", () => {
		const [head, tail] = breakMessage("short message", 50);
		expect(head).toBe("short message");
		expect(tail).toBe("");
	});

	test("head always fits within the limit for realistic content", () => {
		const paragraph = ("some words here and there. ").repeat(200);
		const [head] = breakMessage(paragraph, MESSAGE_MAX_LENGTH);
		expect(head.length).toBeLessThanOrEqual(MESSAGE_MAX_LENGTH);
	});
});

describe("breakAndFixMessage", () => {
	test("closes an open codeblock and carries the fence header into the leftover", () => {
		const code = "const value = 1;\n".repeat(20).trim();
		const message = `intro line\n\`\`\`js\n${code}`;
		// Force the break inside the codeblock.
		const { splitted, leftover } = breakAndFixMessage(message, 60);

		expect(splitted.endsWith("\n```")).toBe(true);
		expect(leftover.startsWith("```js\n")).toBe(true);
		// The leftover codeblock is still open (it re-opened with the header).
		expect(checkClosingBlocks(leftover).isInCodeblock).toBe(true);
	});

	test("closes open inline code and reopens it in the leftover", () => {
		// The break lands after the first line, whose single backtick leaves
		// an open inline-code span.
		const message = "code ` start\nmore words here";
		const { splitted, leftover } = breakAndFixMessage(message, 20);

		expect(splitted).toBe("code ` start`");
		expect(leftover).toBe("`more words here");
	});

	test("leaves balanced content untouched", () => {
		const message = "first paragraph\nsecond paragraph";
		const { splitted, leftover, leftoverInfo } = breakAndFixMessage(message, 20);

		expect(splitted).toBe("first paragraph");
		expect(leftover).toBe("second paragraph");
		expect(leftoverInfo).toEqual({ isInCode: false, isInCodeblock: false, codeblockHeader: null });
	});
});
