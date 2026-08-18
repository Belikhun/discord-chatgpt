import signale from "signale";

const { Signale } = signale;

const options: signale.SignaleOptions = {
	disabled: false,
	interactive: false,
	logLevel: "info",
	scope: "application",
	stream: process.stdout,
	secrets: [],

	types: {
		await: {
			label: "đang chạy"
		},

		success: {
			label: "thành công"
		},

		error: {
			label: "lỗi"
		},

		warn: {
			label: "cảnh báo"
		},

		debug: {
			label: "debug"
		},

		pending: {
			label: "đang chờ"
		},

		watch: {
			label: "theo dõi"
		},

		complete: {
			label: "hoàn thành"
		}
	} as signale.SignaleOptions["types"]
};

export type Logger = signale.Signale;

export const log = new Signale(options);

export const scope = (scope: string): Logger => new Signale({
	...options,
	scope
});

export const interactive = (scope: string): Logger => new Signale({
	...options,
	scope,
	interactive: true
});
