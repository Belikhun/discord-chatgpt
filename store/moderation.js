import fs from "node:fs";
import path from "node:path";
import { scope } from "../logger.js";

const log = scope("moderation-store");
export const moderationFilePath = path.join(process.cwd(), "data", "moderation.json");

export function ensureModerationStore() {
	if (!fs.existsSync(moderationFilePath)) {
		fs.mkdirSync(path.dirname(moderationFilePath), { recursive: true });
		fs.writeFileSync(moderationFilePath, "{}", "utf8");
	}
}

export function loadModerationStore() {
	ensureModerationStore();

	try {
		const raw = fs.readFileSync(moderationFilePath, "utf8");
		return JSON.parse(raw || "{}");
	} catch (err) {
		log.error(`Không thể đọc moderation.json: ${err.message}`);
		return {};
	}
}

export function saveModerationStore(store) {
	ensureModerationStore();
	fs.writeFileSync(moderationFilePath, JSON.stringify(store, null, 2), "utf8");
}

function createEmptyProfile(userId) {
	return {
		userId,
		warningCount: 0,
		kickCount: 0,
		banCount: 0,
		lastAction: null,
		actions: []
	};
}

function normalizeProfile(userId, profile = {}) {
	const normalized = {
		...createEmptyProfile(userId),
		...profile
	};

	normalized.actions = Array.isArray(normalized.actions)
		? normalized.actions.slice(0, 25)
		: [];
	normalized.warningCount = Number.isFinite(normalized.warningCount)
		? normalized.warningCount
		: normalized.actions.filter((item) => item?.action === "warning").length;
	normalized.kickCount = Number.isFinite(normalized.kickCount)
		? normalized.kickCount
		: normalized.actions.filter((item) => item?.action === "kick").length;
	normalized.banCount = Number.isFinite(normalized.banCount)
		? normalized.banCount
		: normalized.actions.filter((item) => item?.action === "ban").length;

	if (!normalized.lastAction && normalized.actions.length > 0) {
		const [latest] = normalized.actions;
		normalized.lastAction = {
			action: latest.action,
			reason: latest.reason || null,
			createdAt: latest.createdAt || null
		};
	}

	return normalized;
}

function getGuildProfiles(store, guildId) {
	if (!store[guildId] || typeof store[guildId] !== "object")
		store[guildId] = {};

	return store[guildId];
}

export function getModerationProfile(guildId, userId) {
	if (!guildId || !userId)
		return createEmptyProfile(userId || null);

	const store = loadModerationStore();
	const guildProfiles = getGuildProfiles(store, guildId);
	return normalizeProfile(userId, guildProfiles[userId]);
}

export function recordModerationAction(guildId, userId, {
	action,
	reason,
	actorId,
	channelId,
	messageId,
	messageIds
} = {}) {
	if (!guildId)
		throw new Error("Cần guildId để ghi trạng thái kiểm duyệt.");

	if (!userId)
		throw new Error("Cần userId để ghi trạng thái kiểm duyệt.");

	if (!["warning", "kick", "ban"].includes(action))
		throw new Error(`Hành động kiểm duyệt không được hỗ trợ: ${action}`);

	const store = loadModerationStore();
	const guildProfiles = getGuildProfiles(store, guildId);
	const profile = normalizeProfile(userId, guildProfiles[userId]);
	const now = Date.now();
	const entry = {
		id: `${guildId}-${userId}-${now}-${Math.random().toString(36).slice(2, 8)}`,
		action,
		reason: reason || null,
		actorId: actorId || null,
		channelId: channelId || null,
		messageId: messageId || null,
		messageIds: Array.isArray(messageIds) ? messageIds.filter(Boolean).slice(0, 100) : [],
		createdAt: now
	};

	profile.actions.unshift(entry);
	profile.actions = profile.actions.slice(0, 25);

	if (action === "warning")
		profile.warningCount += 1;
	else if (action === "kick")
		profile.kickCount += 1;
	else if (action === "ban")
		profile.banCount += 1;

	profile.lastAction = {
		action,
		reason: entry.reason,
		createdAt: entry.createdAt
	};

	guildProfiles[userId] = profile;
	saveModerationStore(store);

	return {
		ok: true,
		action: entry,
		profile
	};
}