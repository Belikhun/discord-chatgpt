import type { Attachment, Guild, GuildMember, Role, User } from "discord.js";

/**
 * A handle to a sent message that can be edited later. Real discord.js
 * Messages satisfy this, as do interaction-webhook wrappers.
 */
export interface MessageHandle {
	id: string | null;
	edit(payload: any): Promise<any>;
}

/**
 * The channel a conversation lives in. Real text-based discord.js channels
 * satisfy this; a lightweight facade is used for personal-app (`/b`)
 * contexts where the bot cannot access the underlying channel.
 */
export interface ConversationChannel {
	id: string;
	name?: string | null;
	guild?: Guild | null;
	send?(payload: any): Promise<any>;
	sendTyping?(): Promise<void>;
	isTextBased?(): boolean;
	permissionsFor?(user: any): { has(permission: any): boolean } | null;
	messages?: { fetch(options: any): Promise<any> };
}

/**
 * A message entering a conversation. Real discord.js Messages satisfy this
 * structurally; InteractionMessage adapts slash-command interactions to it.
 */
export interface IncomingMessage {
	id: string;
	content: string;
	author: User;
	member?: GuildMember | null;
	guild?: Guild | null;
	channel: any;
	attachments: ReadonlyMap<string, Attachment>;
	components: readonly any[];
	reference?: { messageId?: string | null } | null;
	mentions: {
		users: ReadonlyMap<string, User>;
		roles: ReadonlyMap<string, Role>;
		members?: ReadonlyMap<string, GuildMember> | null;
	};
	reply(payload: any): Promise<any>;
}

export type ConversationMode = "chat" | "assistant";
