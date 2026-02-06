
export const ALL_EMOJIS = {
	renxYAPPING: ["1378753055587303485", true],
	renxLUL: ["1384826623731306597", true],
	renxCHATTING: ["1381957364319649804", true],
	renxSHY: ["1385237549878087800", true],
	renxLAUGH: ["1378752761331716229", true],
	renxCAUGHT: ["1381957367851384933", true],
	renxBRAINROT: ["1381957362100731934", true],
	renxHYPE: ["1378753520450408539", true],
	PopCat: ["869043619489787946", false],
	PopCatO: ["869043875849830440", false],
	KEKW: ["868140263921565746", false],
	catStare: ["868139955074003045", false],
	catangery: ["864692078238498827", false],
	catdespair: ["1358818078435180616", false],
	catmiddlefinger: ["1187408817777020978", false],
	catthumbsdown: ["1353648099096006697", false],
	catthumbsup: ["1353648100958408765", false],
	catKiss: ["923425661329240065", true],
	browhat: ["1331531999411703893", false],
	dogebonk: ["869520806672220210", false],
	thonk: ["896015612688621609", false],
	thinkies: ["1346155697494167573", false],
	yaelicking: ["1461204738430468170", true],
	renxHAH: ["1378754691407675452", false],
	catUhh: ["1433663509312307351", false],
	catExplode: ["1434528005903880204", true],
	what: ["1445050239433314464", false],
	muhehehe: ["1445289930220765204", false],
	catJAM: ["896780067433230408", true],
	catJAMCry: ["923425660360355910", true],
	dogewoweew: ["864684144835559444", false],
	renxBARK: ["1440924589252411433", true],
	renxAAAA: ["1468528377169182801", true],
	renxLOOKDOWN: ["1381957356807651410", true],
	takE: ["868140125736017990", false],
	renxPLEAD: ["1468528682426564689", true],
	renxNOW: ["1468531545089376266", true],
	renxNERD: ["1378754881074106499", true],
	renxBARK: ["1440924589252411433", true],
	renxAWW: ["1440924723197378621", false],
	yaelicking: ["1461204738430468170", true],
}

/**
 * Available custom emojis.
 * 
 * @param		{string}				name
 * @returns		{[string, boolean]}		ID and animated status
 */
export function emojis(name) {
	return ALL_EMOJIS[name] || null;
}

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
