import { ChannelType, MessageFlags, PermissionsBitField } from "discord.js";
import { discord } from "../clients/discord.js";
import { getChannel, getGuild, getUser } from "../clients/discord.js";
import { scope } from "../logger.js";
import { ALL_EMOJIS } from "../utils.js";
import { listConversations as listStoredConversations } from "../store/conversation.js";
import { listMemoriesForGuild, createMemoryForGuild } from "../store/memory.js";
import { clearUserWarnings, getModerationProfile, recordModerationAction, listGuildModerationProfiles, getModerationHistory, WARNING_EXPIRATION_MS, WARNING_THRESHOLD_FOR_KICK } from "../store/moderation.js";
import { searchWiki, searchWikiContent, readWikiContent } from "../store/minecraftWiki.js";

export class ChatTool {
	static log = scope("chat-tool");
	static componentTypes = {
		Container: 17,
		Separator: 14,
		TextDisplay: 10
	};

	static moderationColors = {
		warning: 0xF59E0B,
		forgive: 0x16A34A,
		kick: 0xF97316,
		ban: 0xDC2626
	};

	static baseTools() {
		return [
			{
				type: "function",
				name: "get_user_info",
				description: "Get detailed information about a Discord user, including basic profile info and roles in a specific server.",
				strict: true,
				parameters: {
					type: "object",
					properties: {
						userId: {
							type: "string",
							description: "Discord user ID."
						},
						guildId: {
							type: ["string", "null"],
							description: "Discord guild (server) ID to resolve roles. If null, use the current server when available."
						},
						includePresence: {
							type: ["boolean", "null"],
							description: "Include presence info if available."
						}
					},
					required: ["userId", "guildId", "includePresence"],
					additionalProperties: false
				}
			},
			{
				type: "function",
				name: "react_message",
				description: "React to a Discord message. Provide emoji as: (1) Unicode emoji like 😄, OR (2) custom emoji ID like 123456789012345678, OR (3) emoji mention formats like <:name:id>, <a:name:id>, name:id, a:name:id (the tool will extract the ID).",
				strict: true,
				parameters: {
					type: "object",
					properties: {
						channelId: {
							type: ["string", "null"],
							description: "Channel ID containing the target message. If null, use the current channel."
						},
						messageId: {
							type: "string",
							description: "Message ID to react to."
						},
						emoji: {
							type: "string",
							description: "Emoji to react with. Use Unicode (😄), ID (123456789012345678), or formats <:name:id>, <a:name:id>, name:id, a:name:id."
						}
					},
					required: ["channelId", "messageId", "emoji"],
					additionalProperties: false
				}
			},
			{
				type: "function",
				name: "forward_message",
				description: "Forward a message from one channel to another, optionally including attachments and embeds.",
				strict: true,
				parameters: {
					type: "object",
					properties: {
						fromChannelId: {
							type: ["string", "null"],
							description: "Source channel ID. If null, use the current channel."
						},
						messageId: {
							type: "string",
							description: "Message ID to forward."
						},
						toChannelId: {
							type: "string",
							description: "Destination channel ID."
						},
						includeAttachments: {
							type: ["boolean", "null"],
							description: "Include attachments if available."
						},
						includeEmbeds: {
							type: ["boolean", "null"],
							description: "Include embeds if available."
						}
					},
					required: ["fromChannelId", "messageId", "toChannelId", "includeAttachments", "includeEmbeds"],
					additionalProperties: false
				}
			},
			{
				type: "function",
				name: "get_server_info",
				description: "Get information about a Discord server (guild), including channels and roles if requested.",
				strict: true,
				parameters: {
					type: "object",
					properties: {
						guildId: {
							type: ["string", "null"],
							description: "Guild ID to query. If null, use the current server when available."
						},
						includeChannels: {
							type: ["boolean", "null"],
							description: "Include the list of channels."
						},
						includeRoles: {
							type: ["boolean", "null"],
							description: "Include the list of roles."
						}
					},
					required: ["guildId", "includeChannels", "includeRoles"],
					additionalProperties: false
				}
			},
			{
				type: "function",
				name: "list_memories",
				description: "List or search short-term memory items for a Discord server.",
				strict: true,
				parameters: {
					type: "object",
					properties: {
						guildId: {
							type: ["string", "null"],
							description: "Guild ID to query. If null, use the current server when available."
						},
						query: {
							type: ["string", "null"],
							description: "Search query to filter memory items by content."
						},
						limit: {
							type: ["number", "null"],
							description: "Maximum number of items to return."
						}
					},
					required: ["guildId", "query", "limit"],
					additionalProperties: false
				}
			},
			{
				type: "function",
				name: "create_memory",
				description: "Create a short-term memory item in the server's memory bank with an optional custom expiration duration (in seconds).",
				strict: true,
				parameters: {
					type: "object",
					properties: {
						guildId: {
							type: ["string", "null"],
							description: "Guild ID to store memory. If null, use the current server when available."
						},
						content: {
							type: "string",
							description: "Memory content to store."
						},
						ttlSeconds: {
							type: ["number", "null"],
							description: "Expiration duration in seconds. If null, use the default duration."
						}
					},
					required: ["guildId", "content", "ttlSeconds"],
					additionalProperties: false
				}
			},
			{
				type: "function",
				name: "list_conversations",
				description: "List stored chat conversations for other channels (in-memory history).",
				strict: true,
				parameters: {
					type: "object",
					properties: {
						guildId: {
							type: ["string", "null"],
							description: "Guild ID to filter. If null, use the current server when available."
						},
						includeCurrent: {
							type: ["boolean", "null"],
							description: "Include the current channel in results. Default false."
						},
						limit: {
							type: ["number", "null"],
							description: "Maximum number of conversations to return."
						}
					},
					required: ["guildId", "includeCurrent", "limit"],
					additionalProperties: false
				}
			},
			{
				type: "function",
				name: "search_conversation_history",
				description: "Search in-memory ChatConversation history across other channels.",
				strict: true,
				parameters: {
					type: "object",
					properties: {
						guildId: {
							type: ["string", "null"],
							description: "Guild ID to filter. If null, use the current server when available."
						},
						channelIds: {
							type: ["array", "null"],
							items: { type: "string" },
							description: "Optional list of channel IDs to search. If null, search all stored channels."
						},
						query: {
							type: "string",
							description: "Search text to match in stored conversation history."
						},
						limit: {
							type: ["number", "null"],
							description: "Maximum number of matched entries to return."
						},
						maxPerChannel: {
							type: ["number", "null"],
							description: "Maximum results per channel."
						},
						includeCurrent: {
							type: ["boolean", "null"],
							description: "Include the current channel in search. Default false."
						}
					},
					required: ["guildId", "channelIds", "query", "limit", "maxPerChannel", "includeCurrent"],
					additionalProperties: false
				}
			},
			{
				type: "function",
				name: "list_emojis",
				description: "List available custom emojis with id, name, and animated flag.",
				strict: true,
				parameters: {
					type: "object",
					properties: {
						query: {
							type: ["string", "null"],
							description: "Optional name filter to match emoji names."
						}
					},
					required: ["query"],
					additionalProperties: false
				}
			},
			{
				type: "function",
				name: "fetch_recent_messages",
				description: "Fetch the last N messages from a specified channel.",
				strict: true,
				parameters: {
					type: "object",
					properties: {
						channelId: {
							type: ["string", "null"],
							description: "Channel ID to fetch messages from. If null, use the current channel."
						},
						limit: {
							type: "number",
							description: "Number of recent messages to fetch (1-50)."
						}
					},
					required: ["channelId", "limit"],
					additionalProperties: false
				}
			},
			{
				type: "function",
				name: "search_messages",
				description: "Search messages server-wide using Discord's official search endpoint with filters.",
				strict: true,
				parameters: {
					type: "object",
					properties: {
						guildId: {
							type: ["string", "null"],
							description: "Guild ID to search. If null, use the current server when available."
						},
						query: {
							type: "string",
							description: "Search keyword to match in message content (content query)."
						},
						limit: {
							type: ["number", "null"],
							description: "Max results to return (1-25)."
						},
						scanLimit: {
							type: ["number", "null"],
							description: "How many channels to include when auto-selecting (1-50)."
						},
						channelLimit: {
							type: ["number", "null"],
							description: "Max number of channels to scan (1-50)."
						},
						sortBy: {
							type: ["string", "null"],
							description: "Sorting mode (e.g., timestamp)."
						},
						sortOrder: {
							type: ["string", "null"],
							description: "Sorting order (asc or desc)."
						},
						authorIds: {
							type: ["array", "null"],
							items: { type: ["string", "null"] },
							description: "Filter by author IDs."
						},
						mentions: {
							type: ["array", "null"],
							items: { type: ["string", "null"] },
							description: "Filter by mentioned user IDs."
						},
						channelIds: {
							type: ["array", "null"],
							items: { type: "string" },
							description: "Restrict search to specific channel IDs."
						},
						minId: {
							type: ["string", "null"],
							description: "Minimum message ID (snowflake)."
						},
						maxId: {
							type: ["string", "null"],
							description: "Maximum message ID (snowflake)."
						},
						offset: {
							type: ["number", "null"],
							description: "Result offset (0-9975)."
						},
						pinned: {
							type: ["boolean", "null"],
							description: "Only pinned messages."
						},
						includeNsfw: {
							type: ["boolean", "null"],
							description: "Include NSFW channels."
						}
					},
					required: ["guildId", "query", "limit", "scanLimit", "channelLimit", "sortBy", "sortOrder", "authorIds", "mentions", "channelIds", "minId", "maxId", "offset", "pinned", "includeNsfw"],
					additionalProperties: false
				}
			},
			{
				type: "function",
				name: "minecraft_wiki_search",
				description: "Search the Minecraft Wiki for pages matching a query.",
				strict: true,
				parameters: {
					type: "object",
					properties: {
						query: {
							type: "string",
							description: "Search query for the wiki."
						},
						limit: {
							type: ["number", "null"],
							description: "Maximum number of results to return."
						}
					},
					required: ["query", "limit"],
					additionalProperties: false
				}
			},
			{
				type: "function",
				name: "minecraft_wiki_search_content",
				description: "Search the content of a Minecraft Wiki page (cached locally after first fetch).",
				strict: true,
				parameters: {
					type: "object",
					properties: {
						pageId: {
							type: ["number", "null"],
							description: "Page ID to search."
						},
						title: {
							type: ["string", "null"],
							description: "Page title to search."
						},
						query: {
							type: "string",
							description: "Search query to match in page content."
						},
						limit: {
							type: ["number", "null"],
							description: "Maximum number of matched lines to return."
						}
					},
					required: ["pageId", "title", "query", "limit"],
					additionalProperties: false
				}
			},
			{
				type: "function",
				name: "minecraft_wiki_read_content",
				description: "Read cached Minecraft Wiki content by line range.",
				strict: true,
				parameters: {
					type: "object",
					properties: {
						pageId: {
							type: ["number", "null"],
							description: "Page ID to read."
						},
						title: {
							type: ["string", "null"],
							description: "Page title to read."
						},
						startLine: {
							type: ["number", "null"],
							description: "Start line number (1-based)."
						},
						endLine: {
							type: ["number", "null"],
							description: "End line number (1-based)."
						}
					},
					required: ["pageId", "title", "startLine", "endLine"],
					additionalProperties: false
				}
			}
		];
	}

	static async tools(context = {}) {
		return this.baseTools().concat(await this.getModerationTools(context));
	}

	static extractToolCalls(output = []) {
		return output.filter((item) => item?.type === "function_call");
	}

	static async runToolCalls(toolCalls, context = {}) {
		const results = [];

		for (const call of toolCalls) {
			results.push(await this.runToolCall(call, context));
		}

		return results;
	}

	static async runToolCall(call, context = {}) {
		const { name, call_id } = call;
		let args = {};

		try {
			args = (call?.arguments) ? JSON.parse(call.arguments) : {};
		} catch (err) {
			return this.wrapToolOutput(call_id, {
				ok: false,
				error: `Invalid tool arguments JSON: ${err.message}`
			});
		}

		try {
			switch (name) {
				case "issue_warning":
					return this.wrapToolOutput(call_id, await this.issueWarning(args, context));

				case "clear_user_warnings":
					return this.wrapToolOutput(call_id, await this.clearUserWarnings(args, context));

				case "delete_messages":
					return this.wrapToolOutput(call_id, await this.deleteMessages(args, context));

				case "kick_user":
					return this.wrapToolOutput(call_id, await this.kickUser(args, context));

				case "ban_user":
					return this.wrapToolOutput(call_id, await this.banUser(args, context));

				case "query_guild_moderation":
					return this.wrapToolOutput(call_id, await this.queryGuildModeration(args, context));

				case "get_moderation_history":
					return this.wrapToolOutput(call_id, await this.getGuildModerationHistory(args, context));

				case "get_user_info":
					return this.wrapToolOutput(call_id, await this.getUserInfo(args, context));

				case "react_message":
					return this.wrapToolOutput(call_id, await this.reactMessage(args, context));

				case "forward_message":
					return this.wrapToolOutput(call_id, await this.forwardMessage(args, context));

				case "get_server_info":
					return this.wrapToolOutput(call_id, await this.getServerInfo(args, context));

				case "list_memories":
					return this.wrapToolOutput(call_id, await this.listMemories(args, context));

				case "create_memory":
					return this.wrapToolOutput(call_id, await this.createMemory(args, context));

				case "list_conversations":
					return this.wrapToolOutput(call_id, await this.listConversations(args, context));

				case "search_conversation_history":
					return this.wrapToolOutput(call_id, await this.searchConversationHistory(args, context));

				case "list_emojis":
					return this.wrapToolOutput(call_id, await this.listEmojis(args));

				case "fetch_recent_messages":
					return this.wrapToolOutput(call_id, await this.fetchRecentMessages(args, context));

				case "search_messages":
					return this.wrapToolOutput(call_id, await this.searchMessages(args, context));

				case "minecraft_wiki_search":
					return this.wrapToolOutput(call_id, await this.minecraftWikiSearch(args));

				case "minecraft_wiki_search_content":
					return this.wrapToolOutput(call_id, await this.minecraftWikiSearchContent(args));

				case "minecraft_wiki_read_content":
					return this.wrapToolOutput(call_id, await this.minecraftWikiReadContent(args));

				default:
					return this.wrapToolOutput(call_id, {
						ok: false,
						error: `Unknown tool: ${name}`
					});
			}
		} catch (err) {
			const detail = {
				name,
				arguments: args,
				error: err?.message || String(err),
				stack: err?.stack || null
			};
			this.log.error(`Tool ${name} failed: ${detail.error}`);
			this.log.error(detail);
			return this.wrapToolOutput(call_id, {
				ok: false,
				error: err?.message || String(err)
			});
		}
	}

	static wrapToolOutput(callId, payload) {
		return {
			type: "function_call_output",
			call_id: callId,
			output: JSON.stringify(payload)
		};
	}

	static async getModerationTools(context = {}) {
		const capabilities = await this.getModerationCapabilities(context);
		if (!capabilities.fullModerationAccess)
			return [];

		return [
			{
				type: "function",
				name: "issue_warning",
				description: "Record a public moderation warning for a guild member before stronger action. Warnings expire after 24 hours and should be used before kicking when abusive language, swearing, or attacks continue in chat.",
				strict: true,
				parameters: {
					type: "object",
					properties: {
						guildId: {
							type: ["string", "null"],
							description: "Guild ID to moderate in. If null, use the current guild."
						},
						userId: {
							type: "string",
							description: "Discord user ID to warn."
						},
						reason: {
							type: "string",
							description: "Short, specific moderation reason that can be shown publicly."
						},
						evidenceMessageIds: {
							type: ["array", "null"],
							items: { type: "string" },
							description: "Optional related message IDs used as evidence."
						}
					},
					required: ["guildId", "userId", "reason", "evidenceMessageIds"],
					additionalProperties: false
				}
			},
			{
				type: "function",
				name: "clear_user_warnings",
				description: "Clear all active warning status for a guild member when they have rejoined and sincerely apologized. This is a forgiveness action, not a general reset.",
				strict: true,
				parameters: {
					type: "object",
					properties: {
						guildId: {
							type: ["string", "null"],
							description: "Guild ID to moderate in. If null, use the current guild."
						},
						userId: {
							type: "string",
							description: "Discord user ID whose active warnings should be cleared."
						},
						reason: {
							type: "string",
							description: "Short explanation that the member rejoined and apologized, or another specific forgiveness reason."
						},
						evidenceMessageIds: {
							type: ["array", "null"],
							items: { type: "string" },
							description: "Optional message IDs that show the apology or context for clearing warnings."
						}
					},
					required: ["guildId", "userId", "reason", "evidenceMessageIds"],
					additionalProperties: false
				}
			},
			{
				type: "function",
				name: "delete_messages",
				description: "Delete one or more messages in the current guild channel. Supports exact message IDs or cleanup mode using a recent message count with an optional author filter.",
				strict: true,
				parameters: {
					type: "object",
					properties: {
						channelId: {
							type: ["string", "null"],
							description: "Channel ID to delete messages from. If null, use the current channel."
						},
						messageIds: {
							type: ["array", "null"],
							items: { type: "string" },
							description: "Exact message IDs to delete. Leave null when using cleanup mode."
						},
						recentCount: {
							type: ["number", "null"],
							description: "Number of recent messages to delete in cleanup mode (1-100). Leave null when using exact message IDs."
						},
						authorId: {
							type: ["string", "null"],
							description: "Optional author ID filter for cleanup mode."
						},
						reason: {
							type: ["string", "null"],
							description: "Optional moderation reason for the cleanup."
						}
					},
					required: ["channelId", "messageIds", "recentCount", "authorId", "reason"],
					additionalProperties: false
				}
			},
			{
				type: "function",
				name: "kick_user",
				description: "Kick a guild member for continued abusive behavior only after they have 3 active warnings within the last 24 hours. This tool attempts to DM the member before kicking.",
				strict: true,
				parameters: {
					type: "object",
					properties: {
						guildId: {
							type: ["string", "null"],
							description: "Guild ID to moderate in. If null, use the current guild."
						},
						userId: {
							type: "string",
							description: "Discord user ID to kick."
						},
						reason: {
							type: "string",
							description: "Clear moderation reason for the kick."
						},
						evidenceMessageIds: {
							type: ["array", "null"],
							items: { type: "string" },
							description: "Optional related message IDs used as evidence."
						}
					},
					required: ["guildId", "userId", "reason", "evidenceMessageIds"],
					additionalProperties: false
				}
			},
			{
				type: "function",
				name: "ban_user",
				description: "Permanently ban a guild member who returned and continued abusive behavior after a prior kick. This tool attempts to DM the member before banning.",
				strict: true,
				parameters: {
					type: "object",
					properties: {
						guildId: {
							type: ["string", "null"],
							description: "Guild ID to moderate in. If null, use the current guild."
						},
						userId: {
							type: "string",
							description: "Discord user ID to ban."
						},
						reason: {
							type: "string",
							description: "Clear moderation reason for the permanent ban."
						},
						evidenceMessageIds: {
							type: ["array", "null"],
							items: { type: "string" },
							description: "Optional related message IDs used as evidence."
						}
					},
					required: ["guildId", "userId", "reason", "evidenceMessageIds"],
					additionalProperties: false
				}
			},
			{
				type: "function",
				name: "query_guild_moderation",
				description: "Query guild-wide moderation records for warnings, kicks, and bans.",
				strict: true,
				parameters: {
					type: "object",
					properties: {
						guildId: {
							type: ["string", "null"],
							description: "Guild ID to query. If null, use the current guild."
						},
						actionFilter: {
							type: ["array", "null"],
							items: { type: "string" },
							description: "Optional action filters using any of: warning, kick, ban."
						},
						limit: {
							type: ["number", "null"],
							description: "Maximum number of tracked users to return."
						}
					},
					required: ["guildId", "actionFilter", "limit"],
					additionalProperties: false
				}
			},
			{
				type: "function",
				name: "get_moderation_history",
				description: "Retrieve the moderation history log for the guild, optionally filtered by user or action.",
				strict: true,
				parameters: {
					type: "object",
					properties: {
						guildId: {
							type: ["string", "null"],
							description: "Guild ID to query. If null, use the current guild."
						},
						userId: {
							type: ["string", "null"],
							description: "Optional target user ID to filter history."
						},
						action: {
							type: ["string", "null"],
							description: "Optional action filter: warning, clear_warnings, kick, ban, or delete_messages."
						},
						limit: {
							type: ["number", "null"],
							description: "Maximum number of history entries to return."
						}
					},
					required: ["guildId", "userId", "action", "limit"],
					additionalProperties: false
				}
			}
		];
	}

	static async buildDeveloperMessages(context = {}) {
		const moderationText = await this.buildModerationDeveloperPrompt(context);
		if (!moderationText)
			return [];

		return [{
			role: "developer",
			content: [{ type: "input_text", text: moderationText }]
		}];
	}

	static async buildModerationDeveloperPrompt(context = {}) {
		const message = context?.message || null;
		if (!message?.guild || !message?.author)
			return null;

		const capabilities = await this.getModerationCapabilities(context);
		if (!capabilities.fullModerationAccess)
			return null;

		const profile = getModerationProfile(message.guild.id, message.author.id);
		const lastAction = profile.lastAction
			? `${this.describeModerationAction(profile.lastAction.action)} lúc ${new Date(profile.lastAction.createdAt).toISOString()}${profile.lastAction.reason ? ` (${profile.lastAction.reason})` : ""}`
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

	static async getModerationCapabilities(context = {}) {
		if (context.moderationCapabilities)
			return context.moderationCapabilities;

		const channel = context?.message?.channel || context?.conversation?.channel || null;
		const guild = context?.message?.guild || context?.conversation?.channel?.guild || null;
		const unavailable = {
			available: false,
			fullModerationAccess: false,
			guildId: guild?.id || null,
			channelId: channel?.id || null,
			canSend: false,
			canDeleteMessages: false,
			canKickMembers: false,
			canBanMembers: false,
			missingPermissions: ["guild_context"],
			reason: "Guild text channel context is required."
		};

		if (!guild || !channel?.isTextBased?.()) {
			context.moderationCapabilities = unavailable;
			return unavailable;
		}

		let botMember = guild.members.me;
		if (!botMember) {
			try {
				botMember = await guild.members.fetchMe();
			} catch (err) {
				botMember = null;
			}
		}

		const channelPermissions = channel.permissionsFor(botMember || discord.user);
		const canSend = Boolean(channelPermissions?.has(PermissionsBitField.Flags.SendMessages));
		const canDeleteMessages = Boolean(channelPermissions?.has(PermissionsBitField.Flags.ManageMessages));
		const canKickMembers = Boolean(botMember?.permissions.has(PermissionsBitField.Flags.KickMembers));
		const canBanMembers = Boolean(botMember?.permissions.has(PermissionsBitField.Flags.BanMembers));
		const missingPermissions = [];

		if (!canSend)
			missingPermissions.push("SendMessages");
		if (!canDeleteMessages)
			missingPermissions.push("ManageMessages");
		if (!canKickMembers)
			missingPermissions.push("KickMembers");
		if (!canBanMembers)
			missingPermissions.push("BanMembers");

		const capabilities = {
			available: true,
			fullModerationAccess: missingPermissions.length === 0,
			guildId: guild.id,
			channelId: channel.id,
			canSend,
			canDeleteMessages,
			canKickMembers,
			canBanMembers,
			missingPermissions,
			reason: missingPermissions.length === 0
				? null
				: `Missing permissions: ${missingPermissions.join(", ")}`,
			botMember
		};

		context.moderationCapabilities = capabilities;
		return capabilities;
	}

	static async requireFullModerationAccess(context = {}) {
		const capabilities = await this.getModerationCapabilities(context);
		if (capabilities.fullModerationAccess)
			return { ok: true, capabilities };

		return {
			ok: false,
			error: capabilities.reason || "Các công cụ kiểm duyệt không khả dụng trong ngữ cảnh hiện tại."
		};
	}

	static describeModerationAction(action) {
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

	static async resolveGuildMember(guild, userId) {
		if (!guild || !userId)
			return null;

		try {
			return await guild.members.fetch(userId);
		} catch (err) {
			return null;
		}
	}

	static normalizeEvidenceMessageIds(evidenceMessageIds) {
		if (!Array.isArray(evidenceMessageIds))
			return [];

		return [...new Set(evidenceMessageIds.filter(Boolean).map((item) => String(item)))].slice(0, 50);
	}

	static trimReason(reason, fallback = null) {
		const trimmed = (reason || "").trim();
		return trimmed || fallback;
	}

	static summarizeModerationProfile(profile) {
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

	static createTextComponent(content) {
		return {
			type: this.componentTypes.TextDisplay,
			content
		};
	}

	static createSeparatorComponent(spacing = 1, divider = true) {
		return {
			type: this.componentTypes.Separator,
			spacing,
			divider
		};
	}

	static createContainerComponent(components, accentColor) {
		return {
			type: this.componentTypes.Container,
			accent_color: accentColor,
			components
		};
	}

	static formatDiscordTimestamp(timestamp, style = "F") {
		if (!Number.isFinite(timestamp))
			return "không rõ";

		return `<t:${Math.floor(timestamp / 1000)}:${style}>`;
	}

	static async sendStyledNotice(target, components, fallbackContent) {
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
		} catch (err) {
			this.log.warn(`Không thể gửi notice dạng Components V2: ${err.message}`);

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
			} catch (fallbackErr) {
				return {
					attempted: true,
					sent: false,
					error: fallbackErr.message
				};
			}
		}
	}

	static async sendWarningNotice({ channel, member, reason, warningExpiresAt, profile }) {
		if (!channel?.isTextBased?.()) {
			return {
				attempted: false,
				sent: false,
				error: "Không có kênh văn bản phù hợp để gửi cảnh cáo công khai."
			};
		}

		const expiresAtFull = this.formatDiscordTimestamp(warningExpiresAt, "F");
		const expiresAtRelative = this.formatDiscordTimestamp(warningExpiresAt, "R");
		const activeWarnings = profile?.warningCount || 0;
		const warningCard = this.createContainerComponent([
			this.createTextComponent("## ⚠️ Cảnh Cáo Kiểm Duyệt"),
			this.createTextComponent([
				`<@${member.id}>, đây là **cảnh cáo chính thức** từ hệ thống kiểm duyệt của máy chủ.`,
				"",
				`**Lý do vi phạm**`,
				reason
			].join("\n")),
			this.createSeparatorComponent(1, true),
			this.createTextComponent([
				`**Hiệu lực đến:** ${expiresAtFull}`,
				`**Còn lại:** ${expiresAtRelative}`,
				`**Cảnh cáo đang còn hiệu lực:** **${activeWarnings}/${WARNING_THRESHOLD_FOR_KICK}**`
			].join("\n")),
			this.createSeparatorComponent(2, false),
			this.createTextComponent(
				"-# Vui lòng dừng ngay hành vi vi phạm. Nếu tiếp tục tái phạm trong thời gian cảnh cáo còn hiệu lực, bạn có thể bị kick khỏi máy chủ."
			)
		], this.moderationColors.warning);
		const fallbackContent = [
			"⚠️ CẢNH CÁO KIỂM DUYỆT",
			`${member.displayName || member.user?.username || member.id}: đây là cảnh cáo chính thức.`,
			`Lý do: ${reason}`,
			`Hiệu lực đến: ${expiresAtFull} (${expiresAtRelative})`,
			`Cảnh cáo đang còn hiệu lực: ${activeWarnings}/${WARNING_THRESHOLD_FOR_KICK}`,
			"Nếu tiếp tục tái phạm trong thời gian cảnh cáo còn hiệu lực, bạn có thể bị kick khỏi máy chủ."
		].join("\n");

		return this.sendStyledNotice(channel, [warningCard], fallbackContent);
	}

	static async sendWarningClearNotice({ channel, member, reason, clearedWarningCount, profile }) {
		if (!channel?.isTextBased?.()) {
			return {
				attempted: false,
				sent: false,
				error: "Không có kênh văn bản phù hợp để gửi thông báo xóa cảnh cáo."
			};
		}

		const forgivenessCard = this.createContainerComponent([
			this.createTextComponent("## ✅ Cập Nhật Hồ Sơ Kiểm Duyệt"),
			this.createTextComponent([
				`<@${member.id}> đã được **xóa toàn bộ cảnh cáo còn hiệu lực**.`,
				"",
				"**Lý do chấp nhận**",
				reason
			].join("\n")),
			this.createSeparatorComponent(1, true),
			this.createTextComponent([
				`**Số cảnh cáo đã xóa:** ${clearedWarningCount}`,
				`**Cảnh cáo đang còn hiệu lực:** **${profile?.warningCount || 0}/${WARNING_THRESHOLD_FOR_KICK}**`
			].join("\n")),
			this.createSeparatorComponent(2, false),
			this.createTextComponent(
				"-# Hồ sơ được làm sạch để người dùng có cơ hội bắt đầu lại. Nếu tái phạm, hệ thống sẽ ghi nhận lại từ đầu."
			)
		], this.moderationColors.forgive);

		const fallbackContent = [
			"✅ CẬP NHẬT HỒ SƠ KIỂM DUYỆT",
			`${member.displayName || member.user?.username || member.id} đã được xóa toàn bộ cảnh cáo còn hiệu lực.`,
			`Lý do: ${reason}`,
			`Số cảnh cáo đã xóa: ${clearedWarningCount}`,
			`Cảnh cáo đang còn hiệu lực: ${profile?.warningCount || 0}/${WARNING_THRESHOLD_FOR_KICK}`
		].join("\n");

		return this.sendStyledNotice(channel, [forgivenessCard], fallbackContent);
	}

	static buildModerationDmContent({ action, guild, reason }) {
		const isBan = action === "ban";
		const title = isBan ? "## 🔨 Thông Báo Ban Vĩnh Viễn" : "## 👢 Thông Báo Kick";
		const actionLine = isBan
			? "Bạn sẽ bị **ban vĩnh viễn** khỏi máy chủ này ngay sau thông báo này."
			: "Bạn sẽ bị **kick** khỏi máy chủ này ngay sau thông báo này.";
		const guildName = guild?.name || "Discord";

		return {
			components: [
				this.createContainerComponent([
					this.createTextComponent(title),
					this.createTextComponent([
						`**Máy chủ:** ${guildName}`,
						actionLine
					].join("\n")),
					this.createSeparatorComponent(1, true),
					this.createTextComponent([
						"**Lý do xử lý**",
						reason
					].join("\n")),
					this.createSeparatorComponent(2, false),
					this.createTextComponent(
						"-# Nếu bạn cho rằng đây là nhầm lẫn, hãy liên hệ đội ngũ quản trị của máy chủ để được xem xét lại."
					)
				], isBan ? this.moderationColors.ban : this.moderationColors.kick)
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

	static async sendModerationDirectMessage({ member, userId, guild, action, reason }) {
		let user = member?.user || null;

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
			const dmContent = this.buildModerationDmContent({ action, guild, reason });
			const result = await this.sendStyledNotice(user, dmContent.components, dmContent.fallbackContent);
			return {
				...result,
				userId: user.id
			};
		} catch (err) {
			this.log.warn(`Không thể gửi DM kiểm duyệt tới ${user.id}: ${err.message}`);
			return {
				attempted: true,
				sent: false,
				userId: user.id,
				error: err.message
			};
		}
	}

	static async enrichModerationUsers(items = []) {
		const enriched = [];

		for (const item of items) {
			let username = null;
			let displayName = null;

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

	static async resolveChannel(channelId, context) {
		if (channelId)
			return await getChannel(channelId);

		return context?.conversation?.channel || null;
	}

	static async resolveGuild(guildId, context) {
		if (guildId)
			return await getGuild(guildId);

		return context?.conversation?.channel?.guild || null;
	}

	static async getUserInfo({ userId, guildId, includePresence }, context) {
		const user = await getUser(userId);
		const guild = await this.resolveGuild(guildId, context);
		let member = null;

		if (guild) {
			try {
				member = await guild.members.fetch(userId);
			} catch (err) {
				member = null;
			}
		}

		const result = {
			ok: true,
			user: {
				id: user.id,
				username: user.username,
				globalName: user.globalName || null,
				displayName: user.globalName || user.username,
				bot: user.bot,
				createdAt: user.createdAt,
				avatarUrl: user.displayAvatarURL()
			},
			guildMember: null
		};

		if (member) {
			const roles = member.roles.cache
				.sort((a, b) => b.position - a.position)
				.map((role) => ({
					id: role.id,
					name: role.name,
					position: role.position,
					isEveryone: role.id === member.guild.id
				}));

			result.guildMember = {
				guildId: member.guild.id,
				nickname: member.nickname || null,
				displayName: member.displayName,
				joinedAt: member.joinedAt,
				roles,
				permissions: member.permissions.toArray()
			};
		}

		if (includePresence && member?.presence) {
			result.presence = {
				status: member.presence.status,
				activities: member.presence.activities?.map((activity) => ({
					name: activity.name,
					type: activity.type,
					state: activity.state || null
				})) || []
			};
		}

		return result;
	}

	static async reactMessage({ channelId, messageId, emoji }, context) {
		const channel = await this.resolveChannel(channelId, context);

		if (!channel?.isTextBased()) {
			return { ok: false, error: "Target channel is not text-based or not found." };
		}

		let emojiInput = emoji;
		if (typeof emojiInput === "string") {
			const trimmed = emojiInput.trim();
			const customMatch = trimmed.match(/^<a?:\w+:(\d+)>$/);
			const nameMatch = trimmed.match(/^:([a-zA-Z0-9_]+):$/);
			const namedIdMatch = trimmed.match(/^([a-zA-Z0-9_]+)\s*:\s*(\d+)$/);
			const animatedNamedIdMatch = trimmed.match(/^a:([a-zA-Z0-9_]+)\s*:\s*(\d+)$/);
			if (customMatch) {
				emojiInput = customMatch[1];
			} else if (animatedNamedIdMatch) {
				emojiInput = animatedNamedIdMatch[2];
			} else if (namedIdMatch) {
				emojiInput = namedIdMatch[2];
			} else if (nameMatch) {
				const key = nameMatch[1];
				const mapped = ALL_EMOJIS[key];
				if (mapped)
					emojiInput = mapped[0];
			} else if (/^[a-zA-Z0-9_]+$/.test(trimmed)) {
				const mapped = ALL_EMOJIS[trimmed];
				if (mapped)
					emojiInput = mapped[0];
			}
		}

		const message = await channel.messages.fetch(messageId);
		this.log.debug(`Reacting to message ${message.id} in channel ${channel.id} with emoji ${emojiInput}`);
		await message.react(emojiInput);

		return {
			ok: true,
			messageId: message.id,
			emoji: emojiInput
		};
	}

	static async forwardMessage({ fromChannelId, messageId, toChannelId, includeAttachments, includeEmbeds }, context) {
		const fromChannel = await this.resolveChannel(fromChannelId, context);
		const toChannel = await this.resolveChannel(toChannelId, context);

		if (!fromChannel?.isTextBased()) {
			return { ok: false, error: "Source channel is not text-based or not found." };
		}

		if (!toChannel?.isTextBased()) {
			return { ok: false, error: "Destination channel is not text-based or not found." };
		}

		const message = await fromChannel.messages.fetch(messageId);
		const sent = await message.forward(toChannel);

		return {
			ok: true,
			forwardedMessageId: sent.id,
			fromChannelId: fromChannel.id,
			toChannelId: toChannel.id
		};
	}

	static async getServerInfo({ guildId, includeChannels, includeRoles }, context) {
		const guild = await this.resolveGuild(guildId, context);

		if (!guild) {
			return { ok: false, error: "Guild not found or not available in this context." };
		}

		await guild.channels.fetch();

		const info = {
			ok: true,
			guild: {
				id: guild.id,
				name: guild.name,
				memberCount: guild.memberCount,
				ownerId: guild.ownerId,
				createdAt: guild.createdAt,
				preferredLocale: guild.preferredLocale,
				verificationLevel: guild.verificationLevel
			}
		};

		if (includeChannels ?? true) {
			const channels = guild.channels.cache
				.sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0))
				.map((channel) => ({
					id: channel.id,
					name: channel.name,
					type: ChannelType[channel.type] || channel.type,
					parentId: channel.parentId || null
				}));

			info.channels = channels;
		}

		if (includeRoles ?? true) {
			const roles = guild.roles.cache
				.sort((a, b) => b.position - a.position)
				.map((role) => ({
					id: role.id,
					name: role.name,
					position: role.position,
					color: role.color,
					isEveryone: role.id === guild.id
				}));

			info.roles = roles;
		}

		return info;
	}

	static async listMemories({ guildId, query, limit }, context) {
		const guild = await this.resolveGuild(guildId, context);
		if (!guild) {
			return { ok: false, error: "Guild not found or not available in this context." };
		}

		return listMemoriesForGuild(guild, { query, limit });
	}

	static async createMemory({ guildId, content, ttlSeconds }, context) {
		const guild = await this.resolveGuild(guildId, context);
		if (!guild) {
			return { ok: false, error: "Guild not found or not available in this context." };
		}

		return createMemoryForGuild(guild, { content, ttlSeconds, context });
	}

	static async issueWarning({ guildId, userId, reason, evidenceMessageIds }, context) {
		const access = await this.requireFullModerationAccess(context);
		if (!access.ok)
			return access;

		const guild = await this.resolveGuild(guildId, context);
		if (!guild)
			return { ok: false, error: "Không tìm thấy máy chủ hoặc máy chủ không khả dụng trong ngữ cảnh hiện tại." };

		const member = await this.resolveGuildMember(guild, userId);
		if (!member)
			return { ok: false, error: "Không tìm thấy thành viên mục tiêu trong máy chủ." };

		const cleanReason = this.trimReason(reason);
		if (!cleanReason)
			return { ok: false, error: "Cần cung cấp lý do cảnh cáo." };

		const recorded = recordModerationAction(guild.id, member.id, {
			action: "warning",
			reason: cleanReason,
			actorId: discord.user?.id || null,
			channelId: context?.message?.channel?.id || context?.conversation?.channel?.id || null,
			messageId: context?.message?.id || null,
			messageIds: this.normalizeEvidenceMessageIds(evidenceMessageIds)
		});
		const publicNotice = await this.sendWarningNotice({
			channel: context?.message?.channel || context?.conversation?.channel || null,
			member,
			reason: cleanReason,
			warningExpiresAt: recorded.action.metadata?.expiresAt || null,
			profile: recorded.profile
		});

		return {
			ok: true,
			action: "warning",
			guildId: guild.id,
			userId: member.id,
			displayName: member.displayName,
			reason: cleanReason,
			warningExpiresAt: recorded.action.metadata?.expiresAt || null,
			publicNotice,
			profile: this.summarizeModerationProfile(recorded.profile)
		};
	}

	static async clearUserWarnings({ guildId, userId, reason, evidenceMessageIds }, context) {
		const access = await this.requireFullModerationAccess(context);
		if (!access.ok)
			return access;

		const guild = await this.resolveGuild(guildId, context);
		if (!guild)
			return { ok: false, error: "Không tìm thấy máy chủ hoặc máy chủ không khả dụng trong ngữ cảnh hiện tại." };

		const member = await this.resolveGuildMember(guild, userId);
		if (!member)
			return { ok: false, error: "Không tìm thấy thành viên mục tiêu trong máy chủ." };

		const cleanReason = this.trimReason(reason);
		if (!cleanReason)
			return { ok: false, error: "Cần cung cấp lý do xóa cảnh cáo." };

		const recorded = clearUserWarnings(guild.id, member.id, {
			reason: cleanReason,
			actorId: discord.user?.id || null,
			channelId: context?.message?.channel?.id || context?.conversation?.channel?.id || null,
			messageId: context?.message?.id || null,
			messageIds: this.normalizeEvidenceMessageIds(evidenceMessageIds)
		});
		const clearedWarningCount = recorded.action.metadata?.clearedWarningCount || 0;
		const publicNotice = await this.sendWarningClearNotice({
			channel: context?.message?.channel || context?.conversation?.channel || null,
			member,
			reason: cleanReason,
			clearedWarningCount,
			profile: recorded.profile
		});

		return {
			ok: true,
			action: "clear_warnings",
			guildId: guild.id,
			userId: member.id,
			displayName: member.displayName,
			reason: cleanReason,
			clearedWarningCount,
			publicNotice,
			profile: this.summarizeModerationProfile(recorded.profile)
		};
	}

	static async deleteMessages({ channelId, messageIds, recentCount, authorId, reason }, context) {
		const access = await this.requireFullModerationAccess(context);
		if (!access.ok)
			return access;

		const channel = await this.resolveChannel(channelId, context);
		if (!channel?.isTextBased())
			return { ok: false, error: "Không tìm thấy kênh mục tiêu hoặc kênh đó không phải kênh văn bản." };

		const ids = Array.isArray(messageIds) ? [...new Set(messageIds.filter(Boolean))] : [];
		const hasCleanupMode = Number.isFinite(recentCount) && recentCount > 0;
		if (ids.length === 0 && !hasCleanupMode)
			return { ok: false, error: "Hãy cung cấp danh sách messageIds cụ thể hoặc recentCount để dọn kênh." };

		if (ids.length > 0 && hasCleanupMode)
			return { ok: false, error: "Chỉ được dùng một trong hai chế độ: messageIds cụ thể hoặc recentCount để dọn kênh." };

		let targets = [];
		const missingMessageIds = [];
		let scannedCount = 0;

		if (ids.length > 0) {
			const fetches = await Promise.allSettled(ids.slice(0, 100).map((id) => channel.messages.fetch(id)));
			for (let index = 0; index < fetches.length; index += 1) {
				const result = fetches[index];
				if (result.status === "fulfilled") {
					targets.push(result.value);
					continue;
				}

				missingMessageIds.push(ids[index]);
			}
		} else {
			const requestedCount = Math.max(1, Math.min(100, Math.floor(recentCount)));
			const scanBudget = Math.max(requestedCount, Math.min(500, requestedCount * (authorId ? 10 : 3)));
			let before = null;

			while (scannedCount < scanBudget && targets.length < requestedCount) {
				const batch = await channel.messages.fetch({
					limit: Math.min(100, scanBudget - scannedCount),
					...(before ? { before } : {})
				});

				if (batch.size === 0)
					break;

				for (const message of batch.values()) {
					scannedCount += 1;
					if (authorId && message.author.id !== authorId)
						continue;

					targets.push(message);
					if (targets.length >= requestedCount)
						break;
					if (scannedCount >= scanBudget)
						break;
				}

				before = batch.last()?.id;
				if (!before)
					break;
			}
		}

		const cutoff = Date.now() - (14 * 24 * 60 * 60 * 1000);
		const recentMessages = targets.filter((message) => message.createdTimestamp >= cutoff);
		const oldMessages = targets.filter((message) => message.createdTimestamp < cutoff);
		const deletedMessageIds = [];
		const failedMessageIds = [];

		if (recentMessages.length === 1) {
			try {
				await recentMessages[0].delete();
				deletedMessageIds.push(recentMessages[0].id);
			} catch (err) {
				failedMessageIds.push(recentMessages[0].id);
			}
		} else if (recentMessages.length > 1) {
			try {
				const deleted = await channel.bulkDelete(recentMessages, true);
				deletedMessageIds.push(...deleted.keys());
			} catch (err) {
				for (const message of recentMessages) {
					try {
						await message.delete();
						deletedMessageIds.push(message.id);
					} catch (deleteErr) {
						failedMessageIds.push(message.id);
					}
				}
			}
		}

		for (const message of oldMessages) {
			try {
				await message.delete();
				deletedMessageIds.push(message.id);
			} catch (err) {
				failedMessageIds.push(message.id);
			}
		}

		const logged = recordModerationAction(channel.guild?.id || context?.conversation?.channel?.guild?.id, authorId || null, {
			action: "delete_messages",
			reason: this.trimReason(reason),
			actorId: discord.user?.id || null,
			channelId: channel.id,
			messageId: context?.message?.id || null,
			messageIds: deletedMessageIds,
			metadata: {
				mode: ids.length > 0 ? "exact_ids" : "cleanup",
				authorId: authorId || null,
				scannedCount: ids.length > 0 ? ids.length : scannedCount,
				matchedCount: targets.length,
				deletedCount: deletedMessageIds.length,
				missingMessageIds,
				failedMessageIds
			}
		});

		return {
			ok: true,
			action: "delete_messages",
			channelId: channel.id,
			reason: this.trimReason(reason),
			mode: ids.length > 0 ? "exact_ids" : "cleanup",
			authorId: authorId || null,
			scannedCount: ids.length > 0 ? ids.length : scannedCount,
			matchedCount: targets.length,
			deletedCount: deletedMessageIds.length,
			historyId: logged.action.id,
			deletedMessageIds,
			missingMessageIds,
			failedMessageIds
		};
	}

	static async kickUser({ guildId, userId, reason, evidenceMessageIds }, context) {
		const access = await this.requireFullModerationAccess(context);
		if (!access.ok)
			return access;

		const guild = await this.resolveGuild(guildId, context);
		if (!guild)
			return { ok: false, error: "Không tìm thấy máy chủ hoặc máy chủ không khả dụng trong ngữ cảnh hiện tại." };

		const member = await this.resolveGuildMember(guild, userId);
		if (!member)
			return { ok: false, error: "Không tìm thấy thành viên mục tiêu trong máy chủ." };

		const cleanReason = this.trimReason(reason);
		if (!cleanReason)
			return { ok: false, error: "Cần cung cấp lý do kick." };

		const profile = getModerationProfile(guild.id, member.id);
		if ((profile.warningCount || 0) < WARNING_THRESHOLD_FOR_KICK) {
			return {
				ok: false,
				error: `Chỉ được kick sau khi người dùng có ít nhất ${WARNING_THRESHOLD_FOR_KICK} cảnh cáo còn hiệu lực trong 24 giờ gần nhất.`,
				profile: this.summarizeModerationProfile(profile)
			};
		}

		if (!member.kickable)
			return { ok: false, error: "Bot không thể kick thành viên này do thứ bậc role hoặc thiếu quyền." };

		const dmNotification = await this.sendModerationDirectMessage({
			member,
			userId: member.id,
			guild,
			action: "kick",
			reason: cleanReason
		});

		await member.kick(cleanReason);
		const recorded = recordModerationAction(guild.id, member.id, {
			action: "kick",
			reason: cleanReason,
			actorId: discord.user?.id || null,
			channelId: context?.message?.channel?.id || context?.conversation?.channel?.id || null,
			messageId: context?.message?.id || null,
			messageIds: this.normalizeEvidenceMessageIds(evidenceMessageIds),
			metadata: {
				dmNotification
			}
		});

		return {
			ok: true,
			action: "kick",
			guildId: guild.id,
			userId: member.id,
			displayName: member.displayName,
			reason: cleanReason,
			dmNotification,
			profile: this.summarizeModerationProfile(recorded.profile)
		};
	}

	static async banUser({ guildId, userId, reason, evidenceMessageIds }, context) {
		const access = await this.requireFullModerationAccess(context);
		if (!access.ok)
			return access;

		const guild = await this.resolveGuild(guildId, context);
		if (!guild)
			return { ok: false, error: "Không tìm thấy máy chủ hoặc máy chủ không khả dụng trong ngữ cảnh hiện tại." };

		const cleanReason = this.trimReason(reason);
		if (!cleanReason)
			return { ok: false, error: "Cần cung cấp lý do ban." };

		const member = await this.resolveGuildMember(guild, userId);
		if (member && !member.bannable)
			return { ok: false, error: "Bot không thể ban thành viên này do thứ bậc role hoặc thiếu quyền." };

		const dmNotification = await this.sendModerationDirectMessage({
			member,
			userId,
			guild,
			action: "ban",
			reason: cleanReason
		});

		await guild.members.ban(userId, {
			deleteMessageSeconds: 0,
			reason: cleanReason
		});

		const recorded = recordModerationAction(guild.id, userId, {
			action: "ban",
			reason: cleanReason,
			actorId: discord.user?.id || null,
			channelId: context?.message?.channel?.id || context?.conversation?.channel?.id || null,
			messageId: context?.message?.id || null,
			messageIds: this.normalizeEvidenceMessageIds(evidenceMessageIds),
			metadata: {
				dmNotification
			}
		});

		return {
			ok: true,
			action: "ban",
			guildId: guild.id,
			userId,
			displayName: member?.displayName || null,
			reason: cleanReason,
			dmNotification,
			profile: this.summarizeModerationProfile(recorded.profile)
		};
	}

	static async queryGuildModeration({ guildId, actionFilter, limit }, context) {
		const access = await this.requireFullModerationAccess(context);
		if (!access.ok)
			return access;

		const guild = await this.resolveGuild(guildId, context);
		if (!guild)
			return { ok: false, error: "Không tìm thấy máy chủ hoặc máy chủ không khả dụng trong ngữ cảnh hiện tại." };

		const summary = listGuildModerationProfiles(guild.id, { actionFilter, limit });
		return {
			...summary,
			items: await this.enrichModerationUsers(summary.items)
		};
	}

	static async getGuildModerationHistory({ guildId, userId, action, limit }, context) {
		const access = await this.requireFullModerationAccess(context);
		if (!access.ok)
			return access;

		const guild = await this.resolveGuild(guildId, context);
		if (!guild)
			return { ok: false, error: "Không tìm thấy máy chủ hoặc máy chủ không khả dụng trong ngữ cảnh hiện tại." };

		const history = getModerationHistory(guild.id, { userId, action, limit });
		return {
			...history,
			items: await this.enrichModerationUsers(history.items)
		};
	}

	static extractConversationTexts(item) {
		const texts = [];
		if (!item)
			return texts;

		const content = item.content;
		if (Array.isArray(content)) {
			for (const part of content) {
				if (part?.type === "input_text" && typeof part.text === "string")
					texts.push(part.text);
				if (part?.type === "output_text" && typeof part.text === "string")
					texts.push(part.text);
			}
		} else if (typeof content === "string") {
			texts.push(content);
		}

		return texts;
	}

	static async listConversations({ guildId, includeCurrent, limit }, context) {
		const guild = await this.resolveGuild(guildId, context);
		if (guildId && !guild) {
			return { ok: false, error: "Không tìm thấy máy chủ hoặc máy chủ không khả dụng trong ngữ cảnh hiện tại." };
		}

		const currentChannelId = context?.conversation?.channel?.id || null;
		const includeSelf = Boolean(includeCurrent);
		const max = Math.max(1, Math.min(100, Math.floor(limit ?? 50)));

		const items = listStoredConversations()
			.filter((conversation) => {
				if (!conversation?.channel)
					return false;
				if (!includeSelf && conversation.channel.id === currentChannelId)
					return false;
				if (guild?.id && conversation.channel.guild?.id !== guild.id)
					return false;
				return true;
			})
			.map((conversation) => {
				const history = Array.isArray(conversation.history) ? conversation.history : [];
				const lastItem = history.length ? history[history.length - 1] : null;
				return {
					channelId: conversation.channel.id,
					channelName: conversation.channel.name || null,
					guildId: conversation.channel.guild?.id || null,
					mode: conversation.mode,
					model: conversation.model,
					historyCount: history.length,
					lastMessageAt: lastItem?.timestamp ?? null,
					processing: Boolean(conversation.processing)
				};
			})
			.sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));

		return { ok: true, count: items.length, items: items.slice(0, max) };
	}

	static async searchConversationHistory({
		guildId,
		channelIds,
		query,
		limit,
		maxPerChannel,
		includeCurrent
	}, context) {
		const guild = await this.resolveGuild(guildId, context);
		if (guildId && !guild) {
			return { ok: false, error: "Guild not found or not available in this context." };
		}

		const needle = (query || "").trim();
		if (!needle)
			return { ok: false, error: "Search query cannot be empty." };

		const currentChannelId = context?.conversation?.channel?.id || null;
		const includeSelf = Boolean(includeCurrent);
		const maxTotal = Math.max(1, Math.min(200, Math.floor(limit ?? 50)));
		const maxEach = Math.max(1, Math.min(50, Math.floor(maxPerChannel ?? 10)));
		const allowedIds = Array.isArray(channelIds) ? new Set(channelIds.filter(Boolean)) : null;
		const lowerNeedle = needle.toLowerCase();

		const results = [];
		for (const conversation of listStoredConversations()) {
			if (!conversation?.channel)
				continue;
			if (!includeSelf && conversation.channel.id === currentChannelId)
				continue;
			if (guild?.id && conversation.channel.guild?.id !== guild.id)
				continue;
			if (allowedIds && !allowedIds.has(conversation.channel.id))
				continue;

			const history = Array.isArray(conversation.history) ? conversation.history : [];
			let perChannelCount = 0;
			for (const item of history) {
				if (perChannelCount >= maxEach || results.length >= maxTotal)
					break;

				const texts = this.extractConversationTexts(item);
				for (const text of texts) {
					if (perChannelCount >= maxEach || results.length >= maxTotal)
						break;

					if (typeof text !== "string")
						continue;

					const lowerText = text.toLowerCase();
					if (!lowerText.includes(lowerNeedle))
						continue;

					const excerpt = text.length > 500 ? `${text.slice(0, 497)}...` : text;
					results.push({
						channelId: conversation.channel.id,
						channelName: conversation.channel.name || null,
						guildId: conversation.channel.guild?.id || null,
						role: item?.role || null,
						timestamp: item?.timestamp ?? null,
						text: excerpt
					});
					perChannelCount += 1;
				}
			}
			if (results.length >= maxTotal)
				break;
		}

		return { ok: true, count: results.length, items: results };
	}

	static async listEmojis({ query } = {}) {
		const needle = query ? query.toLowerCase() : null;
		let entries = Object.entries(ALL_EMOJIS)
			.map(([name, [id, animated]]) => ({ id, name, animated }));

		if (needle)
			entries = entries.filter((item) => item.name.toLowerCase().includes(needle));

		return { ok: true, total: entries.length, items: entries };
	}

	static async fetchRecentMessages({ channelId, limit }, context) {
		const channel = await this.resolveChannel(channelId, context);
		if (!channel?.isTextBased()) {
			return { ok: false, error: "Target channel is not text-based or not found." };
		}

		const capped = Math.max(1, Math.min(50, Math.floor(limit || 1)));
		const messages = await channel.messages.fetch({ limit: capped });
		const items = Array.from(messages.values())
			.sort((a, b) => b.createdTimestamp - a.createdTimestamp)
			.map((msg) => ({
				id: msg.id,
				channelId: msg.channel.id,
				author: {
					id: msg.author.id,
					username: msg.author.username,
					displayName: msg.member?.displayName || msg.author.globalName || msg.author.username
				},
				content: msg.content,
				createdAt: msg.createdAt,
				attachments: Array.from(msg.attachments.values()).map((att) => ({
					id: att.id,
					name: att.name,
					url: att.url,
					contentType: att.contentType
				}))
			}));

		return { ok: true, count: items.length, items };
	}

	static async searchMessages({
		guildId,
		query,
		limit,
		scanLimit,
		channelLimit,
		sortBy,
		sortOrder,
		authorIds,
		mentions,
		channelIds,
		minId,
		maxId,
		offset,
		pinned,
		includeNsfw
	}, context) {
		const guild = await this.resolveGuild(guildId, context);
		if (!guild) {
			return { ok: false, error: "Guild not found or not available in this context." };
		}

		const needle = (query || "").trim();
		if (!needle) {
			return { ok: false, error: "Search query cannot be empty." };
		}

		const maxResults = Math.max(1, Math.min(25, Math.floor(limit || 10)));
		const channelMax = Math.max(1, Math.min(50, Math.floor(channelLimit || 20)));
		const scanCount = Math.max(1, Math.min(50, Math.floor(scanLimit || channelMax)));

		let resolvedChannelIds = [];
		if (Array.isArray(channelIds) && channelIds.length > 0) {
			resolvedChannelIds = channelIds.filter(Boolean).slice(0, 500);
		} else {
			await guild.channels.fetch();
			const channels = guild.channels.cache
				.filter((ch) => ch.isTextBased() && ch.viewable)
				.sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0))
				.first(channelMax);

			resolvedChannelIds = channels.map((ch) => ch.id).slice(0, scanCount);
		}
		const queryParams = new URLSearchParams();
		queryParams.set("content", needle);
		queryParams.set("limit", String(maxResults));
		if (sortBy)
			queryParams.set("sort_by", sortBy);
		else
			queryParams.set("sort_by", "timestamp");
		if (sortOrder)
			queryParams.set("sort_order", sortOrder);
		else
			queryParams.set("sort_order", "desc");
		if (typeof includeNsfw === "boolean")
			queryParams.set("include_nsfw", String(includeNsfw));
		else
			queryParams.set("include_nsfw", "true");
		if (minId)
			queryParams.set("min_id", minId);
		if (maxId)
			queryParams.set("max_id", maxId);
		if (typeof offset === "number")
			queryParams.set("offset", String(Math.max(0, Math.min(9975, Math.floor(offset)))));
		if (typeof pinned === "boolean")
			queryParams.set("pinned", String(pinned));
		if (Array.isArray(authorIds)) {
			for (const id of authorIds.filter(Boolean))
				queryParams.append("author_id", id);
		}
		if (Array.isArray(mentions)) {
			for (const id of mentions.filter(Boolean))
				queryParams.append("mentions", id);
		}
		for (const id of resolvedChannelIds) {
			queryParams.append("channel_id", id);
		}

		let data = null;
		try {
			data = await discord.rest.get(`/guilds/${guild.id}/messages/search?${queryParams.toString()}`);
		} catch (err) {
			this.log.error(`Message search failed:`, err);

			if (err?.status === 202) {
				return { ok: false, status: 202, error: "Search index not ready. Try again shortly." };
			}
			return { ok: false, error: err?.message || "Failed to search messages via Discord API." };
		}

		const items = (data?.messages || [])
			.flat()
			.slice(0, maxResults)
			.map((msg) => ({
				id: msg.id,
				channelId: msg.channel_id,
				author: {
					id: msg.author?.id,
					username: msg.author?.username,
					displayName: msg.author?.global_name || msg.author?.username
				},
				content: msg.content,
				createdAt: msg.timestamp
			}));

		return { ok: true, count: items.length, total: data?.total_results ?? items.length, items };
	}

	static async minecraftWikiSearch({ query, limit }) {
		try {
			return await searchWiki(query, { limit });
		} catch (err) {
			return { ok: false, error: err?.message || String(err) };
		}
	}

	static async minecraftWikiSearchContent({ pageId, title, query, limit }) {
		try {
			return await searchWikiContent({ pageId, title, query, limit });
		} catch (err) {
			return { ok: false, error: err?.message || String(err) };
		}
	}

	static async minecraftWikiReadContent({ pageId, title, startLine, endLine }) {
		try {
			return await readWikiContent({ pageId, title, startLine, endLine });
		} catch (err) {
			return { ok: false, error: err?.message || String(err) };
		}
	}

	static async minecraftWikiSearch({ query, limit }) {
		try {
			return await searchWiki(query, { limit });
		} catch (err) {
			return { ok: false, error: err?.message || String(err) };
		}
	}

	static async minecraftWikiSearchContent({ pageId, title, query, limit }) {
		try {
			return await searchWikiContent({ pageId, title, query, limit });
		} catch (err) {
			return { ok: false, error: err?.message || String(err) };
		}
	}

	static async minecraftWikiReadContent({ pageId, title, startLine, endLine }) {
		try {
			return await readWikiContent({ pageId, title, startLine, endLine });
		} catch (err) {
			return { ok: false, error: err?.message || String(err) };
		}
	}
}
