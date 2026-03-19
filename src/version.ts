import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const packageMetadata = require("../package.json") as { version?: string };

export const AGENT_VERSION = packageMetadata.version ?? "0.0.0";