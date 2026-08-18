import type { Attachment, ChatInputCommandInteraction, Guild, GuildMember, Role, User } from "discord.js";
import type { MessageHandle } from "../conversation/types";

/**
 * Message-like adapter that wraps a slash command interaction so it can be
 * fed into ChatConversation / ChatCompletion, which are built around
 * Discord Message objects.
 *
 * All outgoing traffic is routed through the interaction webhook
 * (reply / editReply / followUp / webhook.editMessage). This is required for
 * personal (user-installed) app contexts, where the bot has no access to the
 * underlying channel and cannot send or edit messages directly.
 */
export class InteractionMessage {
	interaction: ChatInputCommandInteraction;
	id: string;
	content: string;
	author: User;
	member: GuildMember | null;
	guild: Guild | null;

	attachments: Map<string, Attachment>;
	components: any[];
	reference: null;
	mentions: {
		users: Map<string, User>;
		roles: Map<string, Role>;
		members: Map<string, GuildMember>;
	};

	channel: {
		id: string;
		name: string;
		guild: Guild | null;
		sendTyping: () => Promise<void>;
		send: (payload: any) => Promise<MessageHandle>;
	};

	/**
	 * Create a new interaction message adapter.
	 *
	 * @param	interaction
	 * @param	content		The user's prompt text.
	 */
	constructor(interaction: ChatInputCommandInteraction, content: string) {
		this.interaction = interaction;
		this.id = interaction.id;
		this.content = content;
		this.author = interaction.user;
		this.member = (interaction.member as GuildMember) || null;
		this.guild = interaction.guild || null;

		this.attachments = new Map();
		this.components = [];
		this.reference = null;
		this.mentions = {
			users: new Map(),
			roles: new Map(),
			members: new Map()
		};

		this.channel = {
			id: interaction.channelId,
			name: (interaction.channel as any)?.name || `${interaction.user.displayName}'s chat`,
			guild: interaction.guild || null,
			sendTyping: async () => {},
			send: async (payload: any) => {
				const message = await this.interaction.followUp(payload);
				return this.wrapWebhookMessage(message.id);
			}
		};
	}

	/**
	 * Wrap a webhook (follow-up) message so `.edit()` goes through the
	 * interaction webhook instead of the channel API, which the bot may not
	 * have access to in user-installed app contexts.
	 */
	wrapWebhookMessage(messageId: string): MessageHandle {
		return {
			id: messageId,
			edit: (payload: any) => this.interaction.webhook.editMessage(messageId, payload)
		};
	}

	/**
	 * Send the initial response for this interaction. Returned object exposes
	 * `.edit()` which maps to editing the original interaction reply.
	 */
	async reply(payload: any): Promise<MessageHandle> {
		await this.interaction.reply(payload);

		return {
			id: null,
			edit: (p: any) => this.interaction.editReply(p)
		};
	}
}
