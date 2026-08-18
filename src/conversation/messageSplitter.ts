export const MESSAGE_MAX_LENGTH = 1800;
export const INLINE_CODE_RE = /( \`|\` |^`[^`]|`,|`\.|\(`|`\)|[^`\n]`)/gm;

export interface ClosingBlockState {
	isInCode: boolean;
	isInCodeblock: boolean;
	codeblockHeader: string | null;
}

/**
 * Check closing block status.
 */
export function checkClosingBlocks(content: string): ClosingBlockState {
	let isInCode = false;
	let isInCodeblock = false;
	let codeblockHeader: string | null = null;

	// Check for codeblock
	const codeblockMatch = content.match(/```([a-zA-Z0-9]*)(?:$|\n)/gm);

	if (codeblockMatch && codeblockMatch.length % 2 == 1) {
		isInCodeblock = true;
		codeblockHeader = codeblockMatch[codeblockMatch.length - 1] as string;
	} else {
		// Check for inline code
		const ticks = (content.match(INLINE_CODE_RE) || []).length;

		// Odd number of ticks, we are ending inside inline code.
		isInCode = (ticks % 2 == 1);
	}

	return { isInCode, isInCodeblock, codeblockHeader };
}

/**
 * Break input message to neatly fit into specified maxLength
 */
export function breakMessage(message: string, maxLength: number): [string, string] {
	//* PLAN 1
	//* Backtrace to first line-break occurrence
	let cursor = message.length;

	while (true) {
		const index = message.lastIndexOf("\n", cursor - 1);

		if (index < 0) {
			// No line-break left. We will fallback to 2nd method.
			break;
		}

		if (index + 1 < maxLength) {
			// We can safely break message from this point.
			return [
				message.slice(0, index).trim(),
				message.slice(index, message.length).trim()
			];
		}

		cursor = index;
	}

	//* PLAN 2
	//* Culmulative sentences until reaches limit
	const sentences = message.split(". ");
	let output = "";

	for (const [index, sentence] of sentences.entries()) {
		let current = (output.length > 0)
			? `${output}. ${sentence}`
			: sentence;

		if (current.length > maxLength) {
			// Passed desired length, use current output.
			return [
				`${output}.`,
				sentences.slice(index, sentences.length).join(". ")
			];
		}

		output = current;
	}

	//* PLAN 3
	//* Hard split at max langth
	return [
		message.slice(0, maxLength - 1).trim(),
		message.slice(maxLength - 1, message.length).trim()
	];
}

/**
 * Break input message to neatly fit into specified maxLength, and close
 * leftover codes and codeblocks if broken in mid of message.
 */
export function breakAndFixMessage(message: string, maxLength: number): { splitted: string; leftover: string; leftoverInfo: ClosingBlockState } {
	let [splitted, leftover] = breakMessage(message, maxLength);
	const splittedInfo = checkClosingBlocks(splitted);

	if (splittedInfo.isInCodeblock) {
		// Close opening codeblock and copy header to leftover.
		splitted += `\n\`\`\``;
		leftover = `${splittedInfo.codeblockHeader}\n${leftover}`;
	} else if (splittedInfo.isInCode) {
		splitted += `\``;
		leftover = `\`${leftover}`;
	}

	const leftoverInfo = checkClosingBlocks(leftover);
	return { splitted, leftover, leftoverInfo };
}
