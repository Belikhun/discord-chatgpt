import fs from "fs";
import path from "path";
import { interactive } from "../logger.js";

const defaultConfigName = "config.default.json";
const defaultConfigFile = path.resolve(process.cwd() + "/config/", defaultConfigName);

const configName = "config.json";
const configFile = path.resolve(process.cwd() + "/data/", configName);

if (!fs.existsSync(process.cwd() + "/data"))
	fs.mkdirSync(process.cwd() + "/data", { recursive: true });

const interval = 10000;
let configChanged = false;

export function load() {
	const log = interactive("config:load");
	log.await(`Đang tải file cấu hình ${configName}`);

	try {
		const configData = fs.readFileSync(configFile, "utf8");
		const data = JSON.parse(configData);

		log.success("Đã tải file cấu hình!");
		return data;
	} catch (e) {
		log.warn(e.message);
		log.warn("An error occured while reading config file, falling back to default.");

		const configData = fs.readFileSync(defaultConfigFile, "utf8");
		configChanged = true;
		return JSON.parse(configData);
	}
}

export function save() {
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

export let config = load();

setInterval(() => {
	if (!configChanged)
		return;

	save();
}, interval);


/**
 * Get config value.
 * 
 * @param	{string}					key				Config key
 * @param	{any}						defaultValue	Default value
 * @returns	{string|array|object}
 */
export function get(key, defaultValue = null) {
	if (typeof config[key] === "undefined")
		return defaultValue;

	return config[key];
}

/**
 * Set config value.
 * 
 * @param	{string}		key			Config key
 * @param	{any}			value		Config value
 */
export function set(key, value) {
	config[key] = value;
	configChanged = true;
}

export default {
	config,
	load,
	save,
	get,
	set
}
