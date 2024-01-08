import signale from "signale";
const { Signale, SignaleOptions } = signale;

/** @type {SignaleOptions} */
const options = {
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

		// remind: {
		// 	badge: "**",
		// 	color: "yellow",
		// 	label: "reminder",
		// 	logLevel: "info"
		// },

		// santa: {
		// 	badge: "🎅",
		// 	color: "red",
		// 	label: "santa",
		// 	logLevel: "info"
		// }
	}
};

export const log = new Signale(options);

export const scope = (scope) => new Signale({
	...options,
	scope
});

export const interactive = (scope) => new Signale({
	...options,
	scope,
	interactive: true
});
