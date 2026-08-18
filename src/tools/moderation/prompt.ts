import type { ChatMessage } from "../../ai/types";
import { getModerationProfile, WARNING_EXPIRATION_MS, WARNING_THRESHOLD_FOR_KICK } from "../../stores/moderation";
import type { ToolContext } from "../types";
import { getModerationCapabilities } from "./capabilities";
import { describeModerationAction } from "./helpers";

export async function buildModerationDeveloperPrompt(context: ToolContext = {}): Promise<string | null> {
	const message = context?.message || null;
	if (!message?.guild || !message?.author)
		return null;

	const capabilities = await getModerationCapabilities(context);
	if (!capabilities.fullModerationAccess)
		return null;

	const profile = getModerationProfile(message.guild.id, message.author.id);
	const lastAction = profile.lastAction
		? `${describeModerationAction(profile.lastAction.action)} lúc ${new Date(profile.lastAction.createdAt as number).toISOString()}${profile.lastAction.reason ? ` (${profile.lastAction.reason})` : ""}`
		: "chưa có";

	return [
		"Ngữ cảnh kiểm duyệt:",
		"- Công cụ quản trị hiện khả dụng trong máy chủ này: issue_warning, clear_user_warnings, delete_messages, kick_user, ban_user, query_guild_moderation, get_moderation_history.",
		"- Chỉ kiểm duyệt khi ngữ cảnh thật sự cho thấy quấy rối, lăng mạ, chửi bới nhắm vào người khác hoặc hành vi gây hại rõ ràng. Không được quá nhạy với đùa vui mơ hồ.",
		"- Không gọi issue_warning chỉ vì một câu nói đùa nhẹ, cà khịa qua lại có vẻ đồng thuận, meme nội bộ, hoặc một lần chửi thề chung chung không nhắm vào ai.",
		"- Nếu hai bên cùng đùa, không có dấu hiệu khó chịu, không có yêu cầu dừng lại, và không có hành vi nhắm mục tiêu lặp đi lặp lại, ưu tiên không kiểm duyệt.",
		"- Hãy xem đó là hành vi cần kiểm duyệt khi có một hay nhiều dấu hiệu sau: xúc phạm nhắm đích danh, chửi bới lặp lại, hạ nhục cá nhân, miệt thị ngoại hình/giới tính/chủng tộc, đe dọa, quấy rối tình dục, bám theo gây áp lực, hoặc tiếp tục sau khi bên kia tỏ ra khó chịu hay yêu cầu dừng.",
		"- Nếu ngữ cảnh còn mơ hồ giữa đùa và công kích thật, ưu tiên không cảnh cáo ngay. Chỉ cảnh cáo khi bằng chứng trong đoạn chat đủ rõ ràng.",
		"- Mọi tin nhắn công khai gửi cho người dùng phải viết bằng tiếng Việt.",
		`- Bậc xử lý đầu tiên: gọi issue_warning cho người vi phạm rồi gửi một cảnh cáo ngắn gọn công khai trong kênh. Mỗi cảnh cáo chỉ còn hiệu lực trong ${Math.floor(WARNING_EXPIRATION_MS / (60 * 60 * 1000))} giờ.`,
		"- Nếu người đó đã quay lại máy chủ và xin lỗi một cách rõ ràng, chân thành, có thể gọi clear_user_warnings để xóa toàn bộ cảnh cáo còn hiệu lực của họ. Chỉ dùng khi ngữ cảnh thật sự cho thấy nên tha thứ.",
		`- Chỉ gọi kick_user khi người đó đã có ít nhất ${WARNING_THRESHOLD_FOR_KICK} cảnh cáo còn hiệu lực và vẫn tiếp tục hành vi xấu. Có thể dùng delete_messages trước khi kick nếu cần dọn tin nhắn vi phạm.`,
		"- Trước khi kick hoặc ban, hãy để công cụ gửi thông báo DM cho người vi phạm với lý do rõ ràng bằng tiếng Việt rồi mới thực hiện hành động.",
		"- Nếu người đó đã từng bị kick, quay lại và vẫn tiếp tục hành vi cũ, hãy gọi ban_user vĩnh viễn với lý do rõ ràng bằng tiếng Việt.",
		"- Dùng delete_messages để dọn tin nhắn vi phạm. Công cụ này hỗ trợ cả danh sách message ID cụ thể lẫn chế độ dọn gần đây theo số lượng và bộ lọc tác giả.",
		"- Chỉ kiểm duyệt khi ngữ cảnh chat cho thấy lý do cụ thể. Giữ các tin nhắn kiểm duyệt công khai ngắn gọn, rõ ràng và bằng tiếng Việt.",
		`- Người đang nói: <@${message.author.id}>`,
		`- Hồ sơ kiểm duyệt hiện tại: cảnh cáo còn hiệu lực=${profile.warningCount}/${WARNING_THRESHOLD_FOR_KICK}, tổng cảnh cáo=${profile.totalWarningCount || 0}, kick=${profile.kickCount}, ban=${profile.banCount}, cảnh cáo gần nhất hết hạn=${profile.lastWarningExpiresAt ? new Date(profile.lastWarningExpiresAt).toISOString() : "không có"}, hành động gần nhất=${lastAction}`
	].join("\n");
}

/**
 * Build the developer messages injected ahead of the conversation history
 * (currently only the moderation context, when available).
 */
export async function buildDeveloperMessages(context: ToolContext = {}): Promise<ChatMessage[]> {
	const moderationText = await buildModerationDeveloperPrompt(context);
	if (!moderationText)
		return [];

	return [{
		kind: "message",
		role: "developer",
		content: [{ type: "text", text: moderationText }]
	}];
}
