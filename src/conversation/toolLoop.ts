import { scope } from "../logger";
import { runToolCalls } from "../tools/registry";
import type { ToolContext } from "../tools/types";
import type { ConversationItem, ModelRequest, ModelResponse, ToolCall, ToolResultItem } from "../ai/types";

const log = scope("tool-loop");

export interface ToolLoopOptions {
	/** The request for the first pass; `input` grows as passes run. */
	request: ModelRequest;

	/** Tool runtime context; carries the per-request toolset. */
	context: ToolContext;

	/** Most model passes, the final no-tools pass included. */
	maxPasses: number;

	/**
	 * Run one model pass. The non-streaming chat mode wraps `provider.respond`,
	 * the streaming assistant mode wraps `provider.stream` and renders as it
	 * goes. Returning null means the pass produced nothing (a dropped stream).
	 */
	call(request: ModelRequest): Promise<ModelResponse | null>;

	/** Every item produced (model output, then tool results), for history. */
	onItems(items: ConversationItem[]): void;

	/**
	 * Fired when the model asks for tools, before they run, with any text it
	 * wrote in the same pass (its acknowledgement, when it wrote one).
	 */
	onToolCalls?(calls: ToolCall[], preamble: string): void;

	/** Fired after a batch of tool calls settles, for the tool-call UI. */
	onToolResults?(calls: ToolCall[], outputs: ToolResultItem[]): void;
}

export interface ToolLoopResult {
	/** The last model response, whose `outputText` is the reply. */
	response: ModelResponse | null;
	passes: number;
	/** True when the budget ran out and the final pass was forced to answer. */
	exhausted: boolean;
}

/**
 * The model ↔ tool loop both conversation modes share.
 *
 * Each pass sends the conversation so far; when the model asks for tools they
 * run concurrently and their results go back on the next pass. The last pass
 * of the budget is sent **without tools**, which forces a plain answer: every
 * function call the model made has its output in history, so the next request
 * is never rejected for a dangling call, and the user gets a reply instead of
 * silence when the model keeps reaching for tools.
 */
export async function runToolLoop(options: ToolLoopOptions): Promise<ToolLoopResult> {
	const { context, maxPasses } = options;
	let input = options.request.input;
	let response: ModelResponse | null = null;

	for (let pass = 0; pass < maxPasses; pass++) {
		const finalPass = pass === maxPasses - 1;

		response = await options.call({
			...options.request,
			input,
			tools: finalPass ? [] : options.request.tools
		});

		if (!response)
			return { response: null, passes: pass + 1, exhausted: false };

		options.onItems(response.items);

		if (response.toolCalls.length === 0)
			return { response, passes: pass + 1, exhausted: false };

		if (!finalPass)
			options.onToolCalls?.(response.toolCalls, response.outputText ?? "");

		// The final pass offered no tools, so a call here is the model ignoring
		// that; answer it with an error so history stays well-formed.
		const outputs = finalPass
			? response.toolCalls.map((call): ToolResultItem => ({
				kind: "tool_result",
				callId: call.id,
				output: JSON.stringify({ ok: false, error: "Tool budget exhausted; answer with what you have." })
			}))
			: await runToolCalls(response.toolCalls, context);

		log.info(`Pass ${pass + 1}: ran ${response.toolCalls.map((call) => call.name).join(", ")}`);

		options.onItems(outputs);
		options.onToolResults?.(response.toolCalls, outputs);

		input = input.concat(response.items, outputs);

		if (finalPass)
			return { response, passes: pass + 1, exhausted: true };
	}

	return { response, passes: maxPasses, exhausted: true };
}
