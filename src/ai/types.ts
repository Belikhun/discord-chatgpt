/**
 * Provider-agnostic types for the AI layer.
 *
 * Conversations only ever deal with these neutral structures. Each provider
 * (OpenAI today, Gemini/Claude/… later) translates them from/to its own wire
 * format, and may hand back opaque `ProviderItem`s (reasoning traces, raw
 * assistant outputs, native tool calls) that are stored in history and passed
 * back verbatim on the next request.
 */

export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

/**
 * A capability a model may have. Traits are authored per model in each
 * provider's catalogue, so features are gated by asking for a trait instead of
 * matching model names at the call site.
 */
export enum ModelTrait {
	/** Reasons internally before answering, and can report a thought summary. */
	Thinking = "thinking",

	/** Can call the function tools we declare. */
	FunctionCalling = "functionCalling",

	/** Has a provider-side web search or grounding tool. */
	WebSearch = "webSearch",

	/** Accepts images as input. */
	ViewImage = "viewImage",

	/** Accepts video as input. */
	ViewVideo = "viewVideo",

	/** Accepts audio as input. */
	AnalyzeAudio = "analyzeAudio",

	/** Accepts documents (PDF and friends) as input. */
	ReadDocument = "readDocument",

	/** Returns generated images. */
	GenerateImage = "generateImage",

	/** Returns generated speech or audio. */
	GenerateAudio = "generateAudio",

	/** Returns generated video. */
	GenerateVideo = "generateVideo"
}

/** A model offered by a provider, with the capabilities it supports. */
export interface ModelInfo {
	/** Wire ID. Also the value stored in config and picked in Discord. */
	id: string;

	/** Human-friendly label; falls back to the ID when a provider has none. */
	displayName: string;

	/** Provider that serves this model. */
	provider: string;

	traits: readonly ModelTrait[];
}

export type ChatRole = "user" | "developer" | "assistant";

export type MessagePart =
	| { type: "text"; text: string }
	| { type: "image"; url: string };

/** A neutral chat message authored by the app (user input, developer notes). */
export interface ChatMessage {
	kind: "message";
	role: ChatRole;
	content: MessagePart[];
}

/** An opaque, provider-native history item. Passed back to the same provider verbatim. */
export interface ProviderItem {
	kind: "provider";
	provider: string;
	item: Record<string, any>;
}

/** The result of executing a tool call, fed back to the model. */
export interface ToolResultItem {
	kind: "tool_result";
	callId: string;
	output: string;
}

export type ConversationItem = ChatMessage | ProviderItem | ToolResultItem;

/** A conversation history entry: the item plus when it was recorded. */
export interface HistoryEntry {
	item: ConversationItem;
	timestamp: number;
}

/** A function tool the model can call, in neutral JSON-schema form. */
export interface ToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, any>;
	strict?: boolean;
}

/** A tool invocation requested by the model. */
export interface ToolCall {
	id: string;
	name: string;
	arguments: string;
}

export interface ReasoningConfig {
	effort: ReasoningEffort;
	summary?: "auto";
}

export interface ModelRequest {
	model: string;
	instructions: string;
	input: ConversationItem[];
	tools: ToolDefinition[];
	/** Reasoning effort; only applied when the model supports reasoning. */
	reasoningEffort?: ReasoningEffort | string | null;
	/** Enable the provider's built-in web search tool when supported. */
	enableWebSearch?: boolean;
	/** Enable the provider's built-in image generation tool when supported. */
	enableImageGeneration?: boolean;
}

export interface ModelResponse {
	/** Provider-native items to append to conversation history. */
	items: ConversationItem[];
	/** The assistant's final text output. */
	outputText: string;
	/** Function tool calls requested by the model, if any. */
	toolCalls: ToolCall[];
}

export type StreamEvent =
	| { type: "reasoning_delta"; delta: string }
	| { type: "reasoning_part_added" }
	| { type: "text_delta"; delta: string }
	| { type: "tool_call_added"; callId: string | null; name: string }
	| { type: "image_in_progress"; index: number }
	| { type: "image_generating"; index: number }
	| { type: "image_partial"; index: number; imageBase64: string; format: string; size?: string }
	| { type: "image_completed"; index: number; imageBase64: string; format: string; size?: string; revisedPrompt?: string }
	| { type: "completed"; response: ModelResponse };

/**
 * A chat model provider. Implementations translate neutral requests into
 * provider-specific API calls and normalize the results back.
 */
export interface AIProvider {
	/** Unique provider ID, stamped onto ProviderItems (e.g. "openai"). */
	readonly id: string;

	/** Models offered by this provider, in display order. */
	readonly models: readonly ModelInfo[];

	/**
	 * Metadata for one of this provider's models. Models missing from the
	 * catalogue get traits inferred from their name, so a hand-written
	 * `MODEL_DEFAULT` still behaves sensibly.
	 */
	getModelInfo(model: string): ModelInfo;

	/** Whether the given model has a capability. */
	hasTrait(model: string, trait: ModelTrait): boolean;

	/** One-shot, non-streaming completion. */
	respond(request: ModelRequest): Promise<ModelResponse>;

	/** Streaming completion. Emits a final `completed` event carrying the full response. */
	stream(request: ModelRequest): AsyncGenerator<StreamEvent>;

	/** Simple text-in/text-out helper (used for e.g. memory summarization). */
	generateText(options: { model: string; instructions: string; input: string }): Promise<string>;

	/** Extract plain text fragments from a provider-native history item. */
	extractTexts(item: ProviderItem): string[];
}
