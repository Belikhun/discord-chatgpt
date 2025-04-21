import OpenAI from "openai";

import env from "../env.json" assert { type: "json" };
const { OPENAI_API_KEY } = env;

export const openAI = new OpenAI({ apiKey: OPENAI_API_KEY });

export const models = [
	'o1-pro',
	'gpt-4.1',
	'gpt-4.1-mini',
	'gpt-4.1-nano',
	'o4-mini',
	'o3',
	'o3-mini',
	'o1',
	'o1-preview',
	'o1-mini',
	'gpt-4o',
	'gpt-4o-mini',
	'gpt-4-turbo',
	'gpt-4',
	'gpt-4-0613',
	'gpt-3.5-turbo',
	'gpt-3.5-turbo-16k',
	'gpt-3.5-turbo-0301',
	'gpt-3.5-turbo-0613',
	'gpt-3.5-turbo-1106',
	'gpt-3.5-turbo-0125'
];

export default {
	openAI,
	models
};
