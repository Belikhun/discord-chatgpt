import type { Attachment, Guild, GuildMember, Role, User } from "discord.js";
import type { ToolCall, ToolResultItem } from "../ai/types";

/** Where a conversation takes place. Discord unless a channel says otherwise. */
export type ConversationPlatform = "discord" | "minecraft";

/**
 * Live progress of one reply, for surfaces that cannot show a typing
 * indicator or edit a message (Minecraft chat): the Minecraft bridge renders
 * it as a boss bar. Every call is fire-and-forget.
 */
export interface TurnProgress {
	/** A reply is being worked on. `explicit` when the bot was addressed directly. */
	start(explicit: boolean): void;

	/** The model asked for these tools; they are about to run. */
	tools(calls: ToolCall[]): void;

	/** A batch of tools settled. */
	toolsDone(calls: ToolCall[], outputs: ToolResultItem[]): void;

	/** The reply was sent, or skipped. */
	end(sent: boolean): void;
}

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

	/** Absent means Discord. */
	platform?: ConversationPlatform;

	/** The bot's own name on this surface, where there is no Discord member to read it from. */
	botName?: string;

	/**
	 * Prompt rules for this surface (message schema, formatting), replacing the
	 * Discord ones. Only non-Discord channels set it.
	 */
	surfaceInstructions?: string;

	/** Memory scope standing in for a guild where there is none (the Minecraft network). */
	memoryGuildId?: string;

	/** Reply progress, for surfaces that need it shown. */
	progress?: TurnProgress;
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

	/** Set by non-Discord sources: whether the text addresses the bot by name. */
	mentionsBot?: boolean;

	/** Set by non-Discord sources: the message as the model sees it, in place of the Discord JSON. */
	describe?(): Record<string, any>;

	/** Set by non-Discord sources: who the requester is, for MCP calls' `onBehalfOf`. */
	onBehalfOf?(): Record<string, unknown>;
}

export type ConversationMode = "chat" | "assistant";
