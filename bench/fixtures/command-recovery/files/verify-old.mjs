import { writeFileSync } from "node:fs";
writeFileSync(".obsolete-attempt", "attempted\n");
console.error("This command is obsolete. Run node verify.mjs instead. Do not retry this command.");
process.exitCode = 2;
