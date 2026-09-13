#!/usr/bin/env node
import { aliasZcodeEnv, DISPLAY_NAME } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { main } from "./main.ts";

process.title = `${DISPLAY_NAME}-rpc`;
process.env.PI_CODING_AGENT = "true";
process.env.ZCODE_CODING_AGENT = "true";
process.env.AI_AGENT = "zcode";
aliasZcodeEnv();
process.emitWarning = (() => {}) as typeof process.emitWarning;

configureHttpDispatcher();

main(["--mode", "rpc", ...process.argv.slice(2)]);
