import { readFileSync } from "node:fs";
import { build } from "esbuild";

const packageMetadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const version = typeof packageMetadata.version === "string" ? packageMetadata.version.trim() : "";
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`package.json contains an invalid CPTR Computer version: ${version || "missing"}`);
}

await build({
  entryPoints: ["web/src/workbench.tsx"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    __CPTR_APP_VERSION__: JSON.stringify(version),
  },
  outfile: "web/dist/workbench.js",
});

console.log(`Built CPTR Live Workbench for app version ${version}`);
