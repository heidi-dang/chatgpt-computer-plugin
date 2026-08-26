import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const source = resolve("web/dist");
const destination = resolve("dist/web/dist");

if (!existsSync(source)) {
  throw new Error(`CPTR Live Workbench source bundle is missing: ${source}`);
}
rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
cpSync(source, destination, { recursive: true });
console.log(`Copied CPTR Live Workbench assets to ${destination}`);
