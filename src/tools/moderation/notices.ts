import { MessageFlags, type Guild, type GuildMember, type User } from "discord.js";
import { scope } from "../../logger";
import { getUser } from "../../discord/client";
import { WARNING_THRESHOLD_FOR_KICK, type ModerationProfile } from "../../stores/moderation";

const log = scope("chat-tool");

const componentTypes = {
	Container: 17,
	Separator: 14,
	TextDisplay: 10
};

export const moderationColors = {
	warning: 0xF59E0B,
	forgive: 0x16A34A,
	kick: 0xF97316,
	ban: 0xDC2626
};

export interface NoticeResult {
	attempted: boolean;
	sent: boolean;
	messageId?: string | null;
	fallback?: boolean;
	error?: string;
	userId?: string;
}

export function createTextComponent(content: string) {
	return {
		type: componentTypes.TextDisplay,
		content
	};
}

export function createSeparatorComponent(spacing: number = 1, divider: boolean = true) {
	return {
		type: componentTypes.Separator,
		spacing,
		divider
	};
}

export function createContainerComponent(components: Record<string, any>[], accentColor?: number) {
	return {
		type: componentTypes.Container,
		accent_color: accentColor,
		components
	};
}

export function formatDiscordTimestamp(timestamp: number | null | undefined, style: string = "F"): string {
	if (!Number.isFinite(timestamp as number))
		return "không rõ";

	return `<t:${Math.floor((timestamp as number) / 1000)}:${style}>`;
}

export async function sendStyledNotice(target: any, components: Record<string, any>[], fallbackContent: string): Promise<NoticeResult> {
	if (!target?.send)
		return { attempted: false, sent: false, error: "Đích gửi tin nhắn không hợp lệ." };

	try {
		const sentMessage = await target.send({
			flags: MessageFlags.IsComponentsV2,
			components
		});

		return {
			attempted: true,
			sent: true,
			messageId: sentMessage?.id || null
		};
	} catch (err: any) {
		log.warn(`Không thể gửi notice dạng Components V2: ${err.message}`);

		try {
			const sentMessage = await target.send({
				content: fallbackContent
			});

			return {
				attempted: true,
				sent: true,
				messageId: sentMessage?.id || null,
				fallback: true
			};
		} catch (fallbackErr: any) {
			return {
				attempted: true,
				sent: false,
				error: fallbackErr.message
			};
		}
	}
}

export async function sendWarningNotice({ channel, member, reason, warningExpiresAt, profile }: {
	channel: any;
	member: GuildMember;
	reason: string;
	warningExpiresAt: number | null;
	profile: ModerationProfile | null;
}): Promise<NoticeResult> {
	if (!channel?.isTextBased?.()) {
		return {
			attempted: false,
			sent: false,
			error: "Không có kênh văn bản phù hợp để gửi cảnh cáo công khai."
		};
	}

	const expiresAtFull = formatDiscordTimestamp(warningExpiresAt, "F");
	const expiresAtRelative = formatDiscordTimestamp(warningExpiresAt, "R");
	const activeWarnings = profile?.warningCount || 0;
	const warningCard = createContainerComponent([
		createTextComponent("## ⚠️ Cảnh Cáo Kiểm Duyệt"),
		createTextComponent([
			`<@${member.id}>, đây là **cảnh cáo chính thức** từ hệ thống kiểm duyệt của máy chủ.`,
			"",
			`**Lý do vi phạm**`,
			reason
		].join("\n")),
		createSeparatorComponent(1, true),
		createTextComponent([
			`**Hiệu lực đến:** ${expiresAtFull}`,
			`**Còn lại:** ${expiresAtRelative}`,
			`**Cảnh cáo đang còn hiệu lực:** **${activeWarnings}/${WARNING_THRESHOLD_FOR_KICK}**`
		].join("\n")),
		createSeparatorComponent(2, false),
		createTextComponent(
			"-# Vui lòng dừng ngay hành vi vi phạm. Nếu tiếp tục tái phạm trong thời gian cảnh cáo còn hiệu lực, bạn có thể bị kick khỏi máy chủ."
		)
	], moderationColors.warning);
	const fallbackContent = [
		"⚠️ CẢNH CÁO KIỂM DUYỆT",
		`${member.displayName || member.user?.username || member.id}: đây là cảnh cáo chính thức.`,
		`Lý do: ${reason}`,
		`Hiệu lực đến: ${expiresAtFull} (${expiresAtRelative})`,
		`Cảnh cáo đang còn hiệu lực: ${activeWarnings}/${WARNING_THRESHOLD_FOR_KICK}`,
		"Nếu tiếp tục tái phạm trong thời gian cảnh cáo còn hiệu lực, bạn có thể bị kick khỏi máy chủ."
	].join("\n");

	return sendStyledNotice(channel, [warningCard], fallbackContent);
}

export async function sendWarningClearNotice({ channel, member, reason, clearedWarningCount, profile }: {
	channel: any;
	member: GuildMember;
	reason: string;
	clearedWarningCount: number;
	profile: ModerationProfile | null;
}): Promise<NoticeResult> {
	if (!channel?.isTextBased?.()) {
		return {
			attempted: false,
			sent: false,
			error: "Không có kênh văn bản phù hợp để gửi thông báo xóa cảnh cáo."
		};
	}

	const forgivenessCard = createContainerComponent([
		createTextComponent("## ✅ Cập Nhật Hồ Sơ Kiểm Duyệt"),
		createTextComponent([
			`<@${member.id}> đã được **xóa toàn bộ cảnh cáo còn hiệu lực**.`,
			"",
			"**Lý do chấp nhận**",
			reason
		].join("\n")),
		createSeparatorComponent(1, true),
		createTextComponent([
			`**Số cảnh cáo đã xóa:** ${clearedWarningCount}`,
			`**Cảnh cáo đang còn hiệu lực:** **${profile?.warningCount || 0}/${WARNING_THRESHOLD_FOR_KICK}**`
		].join("\n")),
		createSeparatorComponent(2, false),
		createTextComponent(
			"-# Hồ sơ được làm sạch để người dùng có cơ hội bắt đầu lại. Nếu tái phạm, hệ thống sẽ ghi nhận lại từ đầu."
		)
	], moderationColors.forgive);

	const fallbackContent = [
		"✅ CẬP NHẬT HỒ SƠ KIỂM DUYỆT",
		`${member.displayName || member.user?.username || member.id} đã được xóa toàn bộ cảnh cáo còn hiệu lực.`,
		`Lý do: ${reason}`,
		`Số cảnh cáo đã xóa: ${clearedWarningCount}`,
		`Cảnh cáo đang còn hiệu lực: ${profile?.warningCount || 0}/${WARNING_THRESHOLD_FOR_KICK}`
	].join("\n");

	return sendStyledNotice(channel, [forgivenessCard], fallbackContent);
}

export function buildModerationDmContent({ action, guild, reason }: { action: "kick" | "ban"; guild: Guild | null; reason: string }) {
	const isBan = action === "ban";
	const title = isBan ? "## 🔨 Thông Báo Ban Vĩnh Viễn" : "## 👢 Thông Báo Kick";
	const actionLine = isBan
		? "Bạn sẽ bị **ban vĩnh viễn** khỏi máy chủ này ngay sau thông báo này."
		: "Bạn sẽ bị **kick** khỏi máy chủ này ngay sau thông báo này.";
	const guildName = guild?.name || "Discord";

	return {
		components: [
			createContainerComponent([
				createTextComponent(title),
				createTextComponent([
					`**Máy chủ:** ${guildName}`,
					actionLine
				].join("\n")),
				createSeparatorComponent(1, true),
				createTextComponent([
					"**Lý do xử lý**",
					reason
				].join("\n")),
				createSeparatorComponent(2, false),
				createTextComponent(
					"-# Nếu bạn cho rằng đây là nhầm lẫn, hãy liên hệ đội ngũ quản trị của máy chủ để được xem xét lại."
				)
			], isBan ? moderationColors.ban : moderationColors.kick)
		],
		fallbackContent: [
			isBan ? "🔨 THÔNG BÁO BAN VĨNH VIỄN" : "👢 THÔNG BÁO KICK",
			`Máy chủ: ${guildName}`,
			actionLine.replace(/\*\*/g, ""),
			`Lý do: ${reason}`,
			"Nếu bạn cho rằng đây là nhầm lẫn, hãy liên hệ đội ngũ quản trị của máy chủ để được xem xét lại."
		].join("\n")
	};
}

export async function sendModerationDirectMessage({ member, userId, guild, action, reason }: {
	member: GuildMember | null;
	userId: string | null;
	guild: Guild | null;
	action: "kick" | "ban";
	reason: string;
}): Promise<NoticeResult> {
	let user: User | null = member?.user || null;

	if (!user && userId) {
		try {
			user = await getUser(userId);
		} catch (err) {
			user = null;
		}
	}

	if (!user) {
		return {
			attempted: false,
			sent: false,
			error: "Không thể tải thông tin người dùng để gửi DM trước khi kiểm duyệt."
		};
	}

	try {
		const dmContent = buildModerationDmContent({ action, guild, reason });
		const result = await sendStyledNotice(user, dmContent.components, dmContent.fallbackContent);
		return {
			...result,
			userId: user.id
		};
	} catch (err: any) {
		log.warn(`Không thể gửi DM kiểm duyệt tới ${user.id}: ${err.message}`);
		return {
			attempted: true,
			sent: false,
			userId: user.id,
			error: err.message
		};
	}
}
