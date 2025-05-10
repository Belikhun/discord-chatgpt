
/**
 * Return true if any of the provided items is true.
 * 
 * @template	T
 * @param		{T[]}						items
 * @param		{(item: T) => boolean}		[callback]
 * @returns		{boolean}
 */
export function any(items, callback) {
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
