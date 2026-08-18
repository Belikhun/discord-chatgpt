import type { Guild, GuildMember } from "discord.js";
import { getUser } from "../../discord/client";
import type { ModerationProfile } from "../../stores/moderation";

export function describeModerationAction(action: string): string {
	switch (action) {
		case "warning":
			return "cảnh cáo";

		case "clear_warnings":
			return "xóa cảnh cáo";

		case "kick":
			return "kick";

		case "ban":
			return "ban";

		default:
			return action || "không rõ";
	}
}

export async function resolveGuildMember(guild: Guild | null, userId: string | null | undefined): Promise<GuildMember | null> {
	if (!guild || !userId)
		return null;

	try {
		return await guild.members.fetch(userId);
	} catch (err) {
		return null;
	}
}

export function normalizeEvidenceMessageIds(evidenceMessageIds: unknown): string[] {
	if (!Array.isArray(evidenceMessageIds))
		return [];

	return [...new Set(evidenceMessageIds.filter(Boolean).map((item) => String(item)))].slice(0, 50);
}

export function trimReason(reason: string | null | undefined, fallback: string | null = null): string | null {
	const trimmed = (reason || "").trim();
	return trimmed || fallback;
}

export function summarizeModerationProfile(profile: ModerationProfile | null) {
	return {
		warningCount: profile?.warningCount || 0,
		activeWarningCount: profile?.activeWarningCount || profile?.warningCount || 0,
		totalWarningCount: profile?.totalWarningCount || 0,
		lastWarningExpiresAt: profile?.lastWarningExpiresAt || null,
		kickCount: profile?.kickCount || 0,
		banCount: profile?.banCount || 0,
		lastAction: profile?.lastAction || null
	};
}

export async function enrichModerationUsers<T extends { userId?: string | null }>(items: T[] = []): Promise<(T & { username: string | null; displayName: string | null })[]> {
	const enriched: (T & { username: string | null; displayName: string | null })[] = [];

	for (const item of items) {
		let username: string | null = null;
		let displayName: string | null = null;

		if (item?.userId) {
			try {
				const user = await getUser(item.userId);
				username = user.username;
				displayName = user.globalName || user.username;
			} catch (err) {
				username = null;
				displayName = null;
			}
		}

		enriched.push({
			...item,
			username,
			displayName
		});
	}

	return enriched;
}
