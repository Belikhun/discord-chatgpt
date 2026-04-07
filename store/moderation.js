import fs from "node:fs";
import path from "node:path";
import { scope } from "../logger.js";

const log = scope("moderation-store");
export const moderationFilePath = path.join(process.cwd(), "data", "moderation.json");
const HISTORY_LIMIT = 500;
export const WARNING_EXPIRATION_MS = 24 * 60 * 60 * 1000;
export const WARNING_THRESHOLD_FOR_KICK = 3;

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
		activeWarningCount: 0,
		totalWarningCount: 0,
		kickCount: 0,
		banCount: 0,
		lastWarningExpiresAt: null,
		lastAction: null,
		actions: []
	};
}

function createEmptyGuildStore() {
	return {
		profiles: {},
		history: []
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
	const forgivenWarningIds = getForgivenWarningIds(normalized.actions);
	const activeWarnings = normalized.actions
		.filter((item) => isWarningEntryActive(item) && !forgivenWarningIds.has(item.id))
		.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
	normalized.totalWarningCount = Number.isFinite(normalized.totalWarningCount)
		? normalized.totalWarningCount
		: Number.isFinite(profile.warningCount)
			? profile.warningCount
			: normalized.actions.filter((item) => item?.action === "warning").length;
	normalized.warningCount = activeWarnings.length;
	normalized.activeWarningCount = activeWarnings.length;
	normalized.kickCount = Number.isFinite(normalized.kickCount)
		? normalized.kickCount
		: normalized.actions.filter((item) => item?.action === "kick").length;
	normalized.banCount = Number.isFinite(normalized.banCount)
		? normalized.banCount
		: normalized.actions.filter((item) => item?.action === "ban").length;
	normalized.lastWarningExpiresAt = activeWarnings[0]
		? getWarningExpirationTimestamp(activeWarnings[0])
		: null;

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

function getWarningExpirationTimestamp(entry) {
	if (!entry || entry.action !== "warning")
		return null;

	const metadataExpiresAt = entry.metadata?.expiresAt;
	if (Number.isFinite(metadataExpiresAt))
		return metadataExpiresAt;

	if (Number.isFinite(entry.createdAt))
		return entry.createdAt + WARNING_EXPIRATION_MS;

	return null;
}

function getForgivenWarningIds(actions = []) {
	const forgivenIds = new Set();

	for (const action of actions) {
		if (action?.action !== "clear_warnings")
			continue;

		const clearedWarningIds = Array.isArray(action?.metadata?.clearedWarningIds)
			? action.metadata.clearedWarningIds
			: [];

		for (const warningId of clearedWarningIds) {
			if (warningId)
				forgivenIds.add(warningId);
		}
	}

	return forgivenIds;
}

function listActiveWarningEntries(profile, now = Date.now()) {
	if (!profile || !Array.isArray(profile.actions))
		return [];

	const forgivenWarningIds = getForgivenWarningIds(profile.actions);
	return profile.actions
		.filter((item) => isWarningEntryActive(item, now) && !forgivenWarningIds.has(item.id))
		.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
}

function isWarningEntryActive(entry, now = Date.now()) {
	if (!entry || entry.action !== "warning")
		return false;

	const expiresAt = getWarningExpirationTimestamp(entry);
	if (!Number.isFinite(expiresAt))
		return false;

	return expiresAt > now;
}

function normalizeGuildStoreEntry(entry = {}) {
	if (!entry || typeof entry !== "object")
		return createEmptyGuildStore();

	const normalized = (entry.profiles || entry.history)
		? {
			profiles: (entry.profiles && typeof entry.profiles === "object") ? entry.profiles : {},
			history: Array.isArray(entry.history) ? entry.history.slice(0, HISTORY_LIMIT) : []
		}
		: {
			profiles: entry,
			history: []
		};

	return normalized;
}

function getGuildStore(store, guildId) {
	store[guildId] = normalizeGuildStoreEntry(store[guildId]);
	return store[guildId];
}

export function getModerationProfile(guildId, userId) {
	if (!guildId || !userId)
		return createEmptyProfile(userId || null);

	const store = loadModerationStore();
	const guildStore = getGuildStore(store, guildId);
	return normalizeProfile(userId, guildStore.profiles[userId]);
}

export function recordModerationAction(guildId, userId, {
	action,
	reason,
	actorId,
	channelId,
	messageId,
	messageIds,
	metadata
} = {}) {
	if (!guildId)
		throw new Error("Cần guildId để ghi trạng thái kiểm duyệt.");

	if (!["warning", "kick", "ban", "delete_messages", "clear_warnings"].includes(action))
		throw new Error(`Hành động kiểm duyệt không được hỗ trợ: ${action}`);

	const store = loadModerationStore();
	const guildStore = getGuildStore(store, guildId);
	const profile = userId
		? normalizeProfile(userId, guildStore.profiles[userId])
		: null;
	const now = Date.now();
	const entry = {
		id: `${guildId}-${userId || "guild"}-${now}-${Math.random().toString(36).slice(2, 8)}`,
		guildId,
		userId: userId || null,
		action,
		reason: reason || null,
		actorId: actorId || null,
		channelId: channelId || null,
		messageId: messageId || null,
		messageIds: Array.isArray(messageIds) ? messageIds.filter(Boolean).slice(0, 100) : [],
		metadata: (metadata && typeof metadata === "object") ? { ...metadata } : {},
		createdAt: now
	};

	if (action === "warning" && !Number.isFinite(entry.metadata.expiresAt))
		entry.metadata.expiresAt = now + WARNING_EXPIRATION_MS;

	guildStore.history.unshift(entry);
	guildStore.history = guildStore.history.slice(0, HISTORY_LIMIT);
	let finalProfile = profile;

	if (profile) {
		profile.actions.unshift(entry);
		profile.actions = profile.actions.slice(0, 25);

		if (action === "warning") {
			profile.warningCount += 1;
			profile.activeWarningCount += 1;
			profile.totalWarningCount += 1;
			profile.lastWarningExpiresAt = entry.metadata.expiresAt;
		} else if (action === "kick")
			profile.kickCount += 1;
		else if (action === "ban")
			profile.banCount += 1;

		profile.lastAction = {
			action,
			reason: entry.reason,
			createdAt: entry.createdAt
		};

		finalProfile = normalizeProfile(userId, profile);
		guildStore.profiles[userId] = finalProfile;
	}

	saveModerationStore(store);

	return {
		ok: true,
		action: entry,
		profile: finalProfile
	};
}

export function clearUserWarnings(guildId, userId, {
	reason,
	actorId,
	channelId,
	messageId,
	messageIds,
	metadata
} = {}) {
	if (!guildId || !userId)
		throw new Error("Cần guildId và userId để xóa cảnh cáo của người dùng.");

	const store = loadModerationStore();
	const guildStore = getGuildStore(store, guildId);
	const profile = normalizeProfile(userId, guildStore.profiles[userId]);
	const activeWarnings = listActiveWarningEntries(profile);
	const clearedWarningIds = activeWarnings.map((item) => item.id).filter(Boolean);

	return recordModerationAction(guildId, userId, {
		action: "clear_warnings",
		reason,
		actorId,
		channelId,
		messageId,
		messageIds,
		metadata: {
			...(metadata && typeof metadata === "object" ? metadata : {}),
			clearedWarningIds,
			clearedWarningCount: clearedWarningIds.length
		}
	});
}

export function listGuildModerationProfiles(guildId, {
	actionFilter,
	limit
} = {}) {
	if (!guildId)
		throw new Error("Cần guildId để truy vấn hồ sơ kiểm duyệt.");

	const store = loadModerationStore();
	const guildStore = getGuildStore(store, guildId);
	const filters = Array.isArray(actionFilter)
		? new Set(actionFilter.filter((item) => ["warning", "kick", "ban"].includes(item)))
		: null;
	const max = Math.max(1, Math.min(100, Math.floor(limit ?? 25)));
	const profiles = Object.values(guildStore.profiles)
		.map((profile) => normalizeProfile(profile?.userId || null, profile))
		.filter((profile) => Boolean(profile?.userId));

	const totalWarnings = profiles.reduce((sum, profile) => sum + (profile.warningCount || 0), 0);
	const totalHistoricalWarnings = profiles.reduce((sum, profile) => sum + (profile.totalWarningCount || 0), 0);
	const totalKicks = profiles.reduce((sum, profile) => sum + (profile.kickCount || 0), 0);
	const totalBans = profiles.reduce((sum, profile) => sum + (profile.banCount || 0), 0);

	const items = profiles
		.filter((profile) => {
			if (!filters || filters.size === 0)
				return (profile.warningCount + profile.kickCount + profile.banCount) > 0;

			for (const action of filters) {
				if (action === "warning" && profile.warningCount > 0)
					return true;
				if (action === "kick" && profile.kickCount > 0)
					return true;
				if (action === "ban" && profile.banCount > 0)
					return true;
			}

			return false;
		})
		.sort((left, right) => {
			const leftScore = (left.warningCount || 0) + (left.kickCount || 0) * 2 + (left.banCount || 0) * 3;
			const rightScore = (right.warningCount || 0) + (right.kickCount || 0) * 2 + (right.banCount || 0) * 3;
			if (rightScore !== leftScore)
				return rightScore - leftScore;

			return (right.lastAction?.createdAt ?? 0) - (left.lastAction?.createdAt ?? 0);
		})
		.slice(0, max)
		.map((profile) => ({
			userId: profile.userId,
			warningCount: profile.warningCount || 0,
			activeWarningCount: profile.activeWarningCount || 0,
			totalWarningCount: profile.totalWarningCount || 0,
			lastWarningExpiresAt: profile.lastWarningExpiresAt || null,
			kickCount: profile.kickCount || 0,
			banCount: profile.banCount || 0,
			lastAction: profile.lastAction || null
		}));

	return {
		ok: true,
		guildId,
		totals: {
			warningCount: totalWarnings,
			totalWarningCount: totalHistoricalWarnings,
			kickCount: totalKicks,
			banCount: totalBans
		},
		trackedUserCount: profiles.length,
		items
	};
}

export function getModerationHistory(guildId, {
	userId,
	action,
	limit
} = {}) {
	if (!guildId)
		throw new Error("Cần guildId để lấy lịch sử kiểm duyệt.");

	const store = loadModerationStore();
	const guildStore = getGuildStore(store, guildId);
	const max = Math.max(1, Math.min(100, Math.floor(limit ?? 25)));
	let items = Array.isArray(guildStore.history) ? guildStore.history.slice() : [];

	if (userId)
		items = items.filter((item) => item?.userId === userId);

	if (action)
		items = items.filter((item) => item?.action === action);

	items = items
		.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
		.slice(0, max);

	return {
		ok: true,
		guildId,
		total: items.length,
		items
	};
}