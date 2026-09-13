import { execSync } from "node:child_process";
try {
	execSync("node --test util.test.js", { stdio: "pipe", cwd: process.cwd() });
	console.log("PASS: tests green");
} catch (e) {
	console.log("FAIL: tests red\n" + e.stdout?.toString().slice(0, 500));
	process.exit(1);
}
