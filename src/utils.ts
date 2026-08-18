/**
 * Return true if any of the provided items is truthy, or — when a callback is
 * given — if the callback returns truthy for any item.
 */
export function any<T>(items: T[], callback?: (item: T) => boolean): boolean {
	if (typeof callback === "function") {
		for (const item of items) {
			if (!!callback(item))
				return true;
		}

		return false;
	}

	for (const item of items) {
		if (!!item)
			return true;
	}

	return false;
}
