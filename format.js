import { Message, User } from "discord.js";

export function emojiID(name) {
	switch (name) {
		case "acwarning":
			return "1176594884711436318";

		case "accooldown":
			return "1176594872086573097";

		case "acerror":
			return "1176594875190362132";

		case "acinfo":
			return "1176594877056815256";

		case "acok":
			return "1176594880219336704";

		case "actop":
			return "1176594881968341196";

		case "acwarning":
			return "1176594884711436318";

		case "acscream":
			return "1176604206409465936";

		case "acplus":
			return "1177236771864592444";

		case "acminus":
			return "1177236768370741340";

		case "acdumbbells":
			return "1177261206873063527";
		
		case "loading":
			return "1193949801801322496";
	}

	return `0`;
}

export function emoji(name, animated = false) {
	if (typeof name === "number") {
		return [":zero:", ":one:", ":two:", ":three:", ":four:", ":five:",
				":six:", ":seven:", ":eight:", ":nine:"][name];
	}

	return (animated)
		? `<a:${name}:${emojiID(name)}>`
		: `<:${name}:${emojiID(name)}>`;
}

/**
 * Make message content bold.
 * 
 * @param	{String}	content 
 * @returns	{String}
 */
export function bold(content) {
	return `**${content}**`;
}

/**
 * Make message content underline.
 * 
 * @param	{String}	content 
 * @returns	{String}
 */
export function underline(content) {
	return `__${content}__`;
}

/**
 * Make message content bold.
 * 
 * @param	{String}	content 
 * @returns	{String}
 */
export function italic(content) {
	return `*${content}`;
}

/**
 * Make message content code.
 * 
 * @param	{String}	content 
 * @returns	{String}
 */
export function code(content) {
	return `\`${content}\``;
}

/**
 * Make message content heading 1.
 * 
 * @param	{String}	content 
 * @returns	{String}
 */
export function h1(content) {
	return `# ${content}`;
}

/**
 * Make message content heading 2.
 * 
 * @param	{String}	content 
 * @returns	{String}
 */
export function h2(content) {
	return `## ${content}`;
}

/**
 * Make message content heading 3.
 * 
 * @param	{String}	content 
 * @returns	{String}
 */
export function h3(content) {
	return `### ${content}`;
}

/**
 * Multiline message.
 * 
 * @param		{...String}		lines
 * @returns		{String}
 */
export function lines(...lines) {
	return lines
		.filter(i => (i !== null && i !== undefined))
		.join("\n");
}

/**
 * Format currency number.
 * 
 * @param		{Number}	number 
 * @param		{Object}	options
 * @param		{Boolean}	options.uline
 * @returns		{String}
 */
export function money(number, { uline = false } = {}) {
	const formatter = new Intl.NumberFormat("vi-VN", {
		style: "decimal",
		minimumFractionDigits: 0,
		maximumFractionDigits: 0
	});

	return (uline)
		? `${bold(underline(code(formatter.format(number))))} ${emoji("dongnote")}`
		: `${bold(code(formatter.format(number)))} ${emoji("dongnote")}`;
}

/**
 * Format timestamp to discord date message.
 * 
 * @param	{Number|Date}						date
 * @param	{""|"t"|"T"|"d"|"D"|"f"|"F"|"R"}	format		See {@link https://gist.github.com/LeviSnoot/d9147767abeef2f770e9ddcd91eb85aa}
 * @returns	{String}
 */
export function timestampMessage(date, format = "f") {
	if (date instanceof Date)
		date = (date.getTime() / 1000);

	return `<t:${Math.floor(date)}${format ? `:${format}` : ""}>`;
}

export function trim(string, char) {
	let start = 0, 
		end = string.length;

	while (start < end && string[start] === char)
		++start;

	while (end > start && string[end - 1] === char)
		--end;

	return (start > 0 || end < string.length)
		? string.substring(start, end)
		: string;
}

/**
 * Parse message content as arguments.
 * 
 * @param	{Message}	message 
 * @returns	{String[]|User[]}
 */
export function parseArguments(message) {
	const args = [];
	
	let tokens = message.content.split(" ");
	let quote = null;
	let quoteContent = "";

	for (let token of tokens) {
		if (token.startsWith("<@")) {
			let reg = /\<\@(\d+)\>/.exec(token);
			args.push(message.mentions.users.get(reg[1]));
			continue;
		}

		if (token.endsWith("\"")) {
			if (quote) {
				quoteContent += (" " + trim(token, quote));
				args.push(quoteContent);

				quoteContent = "";
				quote = null;
				continue;
			}
		} else if (token.startsWith("\"")) {
			if (!quote) {
				quote = "\"";
				quoteContent = trim(token, "\"");
				continue;
			}
		}

		if (!token || token.length === 0)
			continue;

		if (quote) {
			quoteContent += ` ${token}`;
			continue;
		}

		args.push(token);
	}

	return args;
}

/**
 * Mention a user.
 * 
 * @param		{String|User}	user
 * @returns		{String}
 */
export function mention(user) {
	if (user instanceof User)
		user = user.id;

	return `<@${user}>`;
}

export function space() {
	return "‎ ‎ ‎ ‎ ‎ ‎ ";
}

export function formatTime(seconds) {
	if (seconds < 0)
		return "Are you trying to break the space-time continuum, you dumbass?";

	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);

	const formattedTime = [];

	if (hours > 0) {
		formattedTime.push(hours + "h");
		seconds -= hours * 3600;
	}

	if (minutes > 0 || hours > 0) {
		formattedTime.push((Math.floor(seconds / 60) % 60) + "m");
		seconds -= minutes * 60;
	}

	if (seconds > 0 || minutes > 0 || hours > 0)
		formattedTime.push(seconds.toFixed(0) + "s");

	const milliseconds = Math.round((seconds - Math.floor(seconds)) * 1000);
	formattedTime.push(milliseconds + "ms");

	return formattedTime.join(" ");
}
