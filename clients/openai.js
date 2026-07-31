import OpenAI from "openai";

import env from "../env.json" with { type: "json" };
const { OPENAI_API_KEY } = env;

export const openAI = new OpenAI({ apiKey: OPENAI_API_KEY });

// Discord limits a slash command option to 25 choices, and this list is fed
// straight into `/model` via addChoices, so it must stay at or under 25.
export const models = [
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.4-nano",
	"gpt-5.2-pro",
	"gpt-5.2",
	"gpt-5.1",
	"gpt-5",
	"gpt-5-mini",
	"gpt-5-nano",
	"o1-pro",
	"gpt-4.1",
	"gpt-4.1-mini",
	"gpt-4.1-nano",
	"o4-mini",
	"o3",
	"o3-mini",
	"o1",
	"gpt-4o",
	"gpt-4o-mini",
	"gpt-4-turbo"
];

export const supportSearch = [
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-5.4",
	"gpt-5.2",
	"gpt-5.1",
	"gpt-5",
	"gpt-5-mini",
	"gpt-4.1",
	"gpt-4.1-mini",
	"gpt-4o",
	"gpt-4o-mini"
];

export const supportImageGeneration = [
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-5.4",
	"gpt-5.2",
	"gpt-5.1",
	"gpt-5",
	"gpt-5-nano"
]

export default {
	openAI,
	models
};
