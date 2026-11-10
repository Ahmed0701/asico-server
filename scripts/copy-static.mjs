import { cpSync } from "node:fs";
import { URL } from "node:url";

const root = new URL("../", import.meta.url);

cpSync(new URL("src/assets", root), new URL("dist/assets", root), { recursive: true });
