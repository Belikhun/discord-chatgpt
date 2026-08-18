import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The config store resolves `data/config.json` from process.cwd() at import
 * time, so we chdir into a scratch directory before importing the module.
 * Keys are FLAT literal strings that may contain dots ("model.<channelId>") —
 * they must never be treated as object paths.
 */

const originalCwd = process.cwd();
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-config-test-"));

let config: typeof import("../src/config");

beforeAll(async () => {
	// The loader falls back to config/config.default.json relative to cwd.
	fs.mkdirSync(path.join(scratchDir, "config"), { recursive: true });
	fs.writeFileSync(path.join(scratchDir, "config", "config.default.json"), "{}", "utf8");

	process.chdir(scratchDir);
	config = await import("../src/config");
	process.chdir(originalCwd);
});

afterAll(() => {
	fs.rmSync(scratchDir, { recursive: true, force: true });
});

describe("flat-key config store", () => {
	test("falls back to the default config when data/config.json is missing", () => {
		expect(config.config).toEqual({});
	});

	test("keys containing dots are literal, not paths", () => {
		config.set("model.1234567890", "gpt-5");

		expect(config.get<string>("model.1234567890")).toBe("gpt-5");
		// No nested object was created.
		expect(config.get<any>("model")).toBe(null);
		expect((config.config as any).model).toBeUndefined();
		expect(Object.keys(config.config)).toContain("model.1234567890");
	});

	test("get returns the provided default for missing keys", () => {
		expect(config.get<any>("does.not.exist")).toBe(null);
		expect(config.get("does.not.exist", "fallback")).toBe("fallback");
	});

	test("get returns stored falsy values instead of the default", () => {
		config.set("some.flag", false);
		expect(config.get("some.flag", true)).toBe(false);
	});

	test("save writes pretty-printed JSON with flat keys preserved", () => {
		config.set("mode.42", "assistant");

		process.chdir(scratchDir);
		try {
			config.save();
		} finally {
			process.chdir(originalCwd);
		}

		const written = fs.readFileSync(path.join(scratchDir, "data", "config.json"), "utf8");
		const parsed = JSON.parse(written);

		expect(parsed["model.1234567890"]).toBe("gpt-5");
		expect(parsed["mode.42"]).toBe("assistant");
		// Pretty-printed with 2-space indentation, as before the refactor.
		expect(written).toBe(JSON.stringify(parsed, null, 2));
	});
});
