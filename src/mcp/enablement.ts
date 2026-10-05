import { db } from "../db";
import type { McpServer } from "./config";

export type EnablementScope = "guild" | "channel";

/** Where a request comes from. */
export interface McpLocation {
	guildId: string | null;
	channelId: string | null;
}

/** Whether a server is on here, and the reason, which `/mcp list` shows. */
export interface McpState {
	enabled: boolean;
	reason: "fenced" | "channel" | "guild" | "default" | "off";
}

interface EnablementRow {
	enabled: number;
}

function row(serverId: string, scope: EnablementScope, scopeId: string): boolean | null {
	const found = db().query("SELECT enabled FROM mcp_enablement WHERE server_id = ? AND scope_kind = ? AND scope_id = ?")
		.get(serverId, scope, scopeId) as EnablementRow | null;

	return found ? !!found.enabled : null;
}

/** Record an enable or disable at one scope. */
export function setEnablement(serverId: string, scope: EnablementScope, scopeId: string, enabled: boolean, setBy: string | null): void {
	db().run(
		`INSERT INTO mcp_enablement (server_id, scope_kind, scope_id, enabled, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT (server_id, scope_kind, scope_id) DO UPDATE SET enabled = excluded.enabled, set_by = excluded.set_by, set_at = excluded.set_at`,
		[serverId, scope, scopeId, enabled ? 1 : 0, setBy, Date.now()]
	);
}

/** Remove a recorded choice, falling back to the wider scope's. */
export function clearEnablement(serverId: string, scope: EnablementScope, scopeId: string): void {
	db().run("DELETE FROM mcp_enablement WHERE server_id = ? AND scope_kind = ? AND scope_id = ?", [serverId, scope, scopeId]);
}

/** Whether a scope may switch this server on (anything may switch it off). */
export function canEnableAt(server: McpServer, scope: EnablementScope): boolean {
	if (scope === "guild")
		return server.config.AVAILABILITY !== "channel";

	return server.config.AVAILABILITY !== "guild";
}

/**
 * Resolve whether a server is on at a location: the fence first, then the
 * channel's choice, then the server's, then the configured default. A channel
 * can always opt out; it can only opt in where the server's availability
 * allows per-channel enabling.
 */
export function resolveMcpState(server: McpServer, location: McpLocation): McpState {
	const { config } = server;

	if (config.ALLOWED_GUILDS && (!location.guildId || !config.ALLOWED_GUILDS.includes(location.guildId)))
		return { enabled: false, reason: "fenced" };

	if (config.ALLOWED_CHANNELS && (!location.channelId || !config.ALLOWED_CHANNELS.includes(location.channelId)))
		return { enabled: false, reason: "fenced" };

	if (location.channelId) {
		const choice = row(server.id, "channel", location.channelId);

		if (choice === false)
			return { enabled: false, reason: "channel" };

		if (choice === true && canEnableAt(server, "channel"))
			return { enabled: true, reason: "channel" };
	}

	if (config.AVAILABILITY !== "channel" && location.guildId) {
		const choice = row(server.id, "guild", location.guildId);

		if (choice !== null)
			return { enabled: choice && canEnableAt(server, "guild"), reason: "guild" };
	}

	if (config.AVAILABILITY === "global" && config.DEFAULT_ENABLED)
		return { enabled: true, reason: "default" };

	return { enabled: false, reason: "off" };
}
