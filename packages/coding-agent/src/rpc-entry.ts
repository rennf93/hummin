#!/usr/bin/env node
import { aliasZcodeEnv, DISPLAY_NAME } from "./config.ts";
import { configureHttpDispatcher } from "./core/undici-runtime.ts";
import { main } from "./main.ts";

process.title = `${DISPLAY_NAME}-rpc`;
process.env.PI_CODING_AGENT = "true";
process.env.HUMMIN_CODING_AGENT = "true";
process.env.AI_AGENT = "hummin";
aliasZcodeEnv();
process.emitWarning = (() => {}) as typeof process.emitWarning;

configureHttpDispatcher();

main(["--mode", "rpc", ...process.argv.slice(2)]);
