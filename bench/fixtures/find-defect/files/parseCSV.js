// See README.md for the documented contract.
export function parseCSV(text) {
	const rows = [];
	let field = "";
	let row = [];
	let inQuotes = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inQuotes) {
			if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
			else if (c === '"') inQuotes = false;
			else field += c;
		} else if (c === '"') inQuotes = true;
		else if (c === ",") { row.push(field); field = ""; }
		else if (c === "\n") { row.push(field); field = ""; rows.push(row); row = []; }
		else if (c === "\r") { /* skip */ }
		else field += c;
	}
	if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
	const [header, ...data] = rows;
	return data.map((r) => Object.fromEntries(header.map((h, idx) => [h, r[idx] ?? ""])));
}
