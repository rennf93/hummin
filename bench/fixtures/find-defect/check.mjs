// Reads the agent's final transcript text from stdout-file passed as argv[2].
import { readFileSync } from "node:fs";
const out = readFileSync(process.argv[2], "utf8").toLowerCase();
const mentionsFn = out.includes("parsecsv");
const mentionsCause =
	out.includes("last") || out.includes("final") || out.includes("trailing") || out.includes("empty line") ||
	out.includes("newline at the end") || out.includes("ghost row") || out.includes("empty row");
const hasDefectLine = out.includes("defect:");
if (mentionsFn && mentionsCause && hasDefectLine) {
	console.log("PASS: defect identified (parseCSV + trailing-newline ghost row)");
} else {
	console.log(`FAIL: fn=${mentionsFn} cause=${mentionsCause} line=${hasDefectLine}`);
	process.exit(1);
}
