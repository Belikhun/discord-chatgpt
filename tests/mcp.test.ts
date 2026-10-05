import { beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, useDatabase } from "../src/db";
import { resolveMcpState, setEnablement } from "../src/mcp/enablement";
import { sanitizeToolName, sanitizeToolSchema } from "../src/mcp/schema";
import type { McpServer, McpServerConfig } from "../src/mcp/config";

function server(id: string, config: Partial<McpServerConfig>): McpServer {
	return { id, name: id, prefix: id, config: { URL: "http://x", AVAILABILITY: "global", ...config } };
}

const here = { guildId: "g1", channelId: "c1" };

beforeEach(() => {
	useDatabase(openDatabase(":memory:"));
});

describe("MCP availability", () => {
	test("global + default is on everywhere and can be disabled per channel", () => {
		const s = server("web", { AVAILABILITY: "global", DEFAULT_ENABLED: true });

		expect(resolveMcpState(s, here)).toEqual({ enabled: true, reason: "default" });
		expect(resolveMcpState(s, { guildId: null, channelId: "dm1" }).enabled).toBe(true);

		setEnablement("web", "channel", "c1", false, "u");
		expect(resolveMcpState(s, here)).toEqual({ enabled: false, reason: "channel" });
		expect(resolveMcpState(s, { guildId: "g1", channelId: "c2" }).enabled).toBe(true);
	});

	test("guild availability is off until the server enables it; a channel may opt out but not in", () => {
		const s = server("luna", { AVAILABILITY: "guild" });

		expect(resolveMcpState(s, here).enabled).toBe(false);

		setEnablement("luna", "channel", "c1", true, "u");
		expect(resolveMcpState(s, here).enabled).toBe(false);

		setEnablement("luna", "guild", "g1", true, "u");
		setEnablement("luna", "channel", "c1", false, "u");
		expect(resolveMcpState(s, here)).toEqual({ enabled: false, reason: "channel" });
		expect(resolveMcpState(s, { guildId: "g1", channelId: "c2" })).toEqual({ enabled: true, reason: "guild" });
	});

	test("channel availability ignores the guild setting", () => {
		const s = server("code", { AVAILABILITY: "channel" });

		setEnablement("code", "guild", "g1", true, "u");
		expect(resolveMcpState(s, here).enabled).toBe(false);

		setEnablement("code", "channel", "c1", true, "u");
		expect(resolveMcpState(s, here)).toEqual({ enabled: true, reason: "channel" });
	});

	test("the guild fence wins over everything, DMs included", () => {
		const s = server("luna", { AVAILABILITY: "global", DEFAULT_ENABLED: true, ALLOWED_GUILDS: ["g1"] });

		expect(resolveMcpState(s, here).enabled).toBe(true);
		expect(resolveMcpState(s, { guildId: "g2", channelId: "c9" })).toEqual({ enabled: false, reason: "fenced" });
		expect(resolveMcpState(s, { guildId: null, channelId: "dm" })).toEqual({ enabled: false, reason: "fenced" });

		setEnablement("luna", "channel", "c9", true, "u");
		expect(resolveMcpState(s, { guildId: "g2", channelId: "c9" }).enabled).toBe(false);
	});
});

describe("MCP schema sanitizing", () => {
	test("inlines $ref, drops $defs and fills the object shape", () => {
		const schema = sanitizeToolSchema({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			properties: { target: { $ref: "#/$defs/Target" } },
			$defs: { Target: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }
		});

		expect(schema.$schema).toBeUndefined();
		expect(schema.$defs).toBeUndefined();
		expect(schema.properties.target).toEqual({ type: "object", properties: { name: { type: "string" } }, required: ["name"] });
	});

	test("a self-referencing schema terminates", () => {
		const schema = sanitizeToolSchema({
			type: "object",
			properties: { node: { $ref: "#/$defs/Node" } },
			$defs: { Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" } } } }
		});

		expect(JSON.stringify(schema).length).toBeLessThan(5000);
	});

	test("missing schema becomes an empty object schema", () => {
		expect(sanitizeToolSchema(undefined)).toEqual({ type: "object", properties: {} });
	});

	test("tool names are provider-safe", () => {
		expect(sanitizeToolName("luna", "cluster_status")).toBe("luna__cluster_status");
		expect(sanitizeToolName("my.server", "do thing")).toBe("my_server__do_thing");
		expect(sanitizeToolName("1x", "t")).toBe("_1x__t");
		expect(sanitizeToolName("p", "x".repeat(100)).length).toBe(64);
	});
});
