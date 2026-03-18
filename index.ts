#!/usr/bin/env bun

import { runCli } from "./src/cli/index.ts";

const exitCode = await runCli(Bun.argv.slice(2));
process.exit(exitCode);
