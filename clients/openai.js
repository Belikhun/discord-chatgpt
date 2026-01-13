import OpenAI from "openai";

import env from "../env.json" with { type: "json" };
const { OPENAI_API_KEY } = env;

export const openAI = new OpenAI({ apiKey: OPENAI_API_KEY });

export const models = [
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
	"o1-preview",
	"o1-mini",
	"gpt-4o",
	"gpt-4o-mini",
	"gpt-4-turbo",
	"gpt-4",
	"gpt-4-0613",
	"gpt-3.5-turbo"
];

export const supportSearch = [
	"gpt-5",
	"gpt-5-mini",
	"gpt-4.1",
	"gpt-4.1-mini",
	"gpt-4o",
	"gpt-4o-mini",
	"gpt-5"
];

export const supportImageGeneration = [
	"gpt-5",
	"gpt-5-nano"
]

export default {
	openAI,
	models
};
