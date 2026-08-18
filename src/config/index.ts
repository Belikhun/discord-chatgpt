import fs from "node:fs";
import path from "node:path";
import { interactive } from "../logger";

const defaultConfigName = "config.default.json";
const defaultConfigFile = path.resolve(process.cwd() + "/config/", defaultConfigName);

const configName = "config.json";
const configFile = path.resolve(process.cwd() + "/data/", configName);

if (!fs.existsSync(process.cwd() + "/data"))
	fs.mkdirSync(process.cwd() + "/data", { recursive: true });

const interval = 10000;
let configChanged = false;

export type ConfigData = Record<string, any>;

export function load(): ConfigData {
	const log = interactive("config:load");
	log.await(`Đang tải file cấu hình ${configName}`);

	try {
		const configData = fs.readFileSync(configFile, "utf8");
		const data = JSON.parse(configData);

		log.success("Đã tải file cấu hình!");
		return data;
	} catch (e: any) {
		log.warn(e.message);
		log.warn("An error occured while reading config file, falling back to default.");

		const configData = fs.readFileSync(defaultConfigFile, "utf8");
		configChanged = true;
		return JSON.parse(configData);
	}
}

export function save(): void {
	const log = interactive("config:save");
	log.await(`Đang lưu file cấu hình ${configName}`);

	try {
		const configData = JSON.stringify(config, null, 2);
		fs.writeFileSync(configFile, configData, "utf8");

		configChanged = false;
		log.success("Lưu file cấu hình thành công!");
	} catch (err) {
		log.error(err);
	}
}

export const config: ConfigData = load();

setInterval(() => {
	if (!configChanged)
		return;

	save();
}, interval);

/**
 * Get config value.
 */
export function get<T = any>(key: string, defaultValue: T | null = null): T {
	if (typeof config[key] === "undefined")
		return defaultValue as T;

	return config[key];
}

/**
 * Set config value.
 */
export function set(key: string, value: any): void {
	config[key] = value;
	configChanged = true;
}

export default {
	config,
	load,
	save,
	get,
	set
};
