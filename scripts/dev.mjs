import { context } from "esbuild";
import { spawn } from "node:child_process";
import { readFileSync, watch } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverDirectory = resolve(root, "server");
const packageMetadata = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const appVersion = typeof packageMetadata.version === "string" ? packageMetadata.version.trim() : "";
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(appVersion)) {
  throw new Error(`package.json contains an invalid CPTR Computer version: ${appVersion || "missing"}`);
}
let child = null;
let restartTimer = null;
let buildCounter = 0;
let closing = false;

function stopChild() {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
}

function startServer(reason) {
  if (closing) return;
  buildCounter += 1;
  const buildId = `${Date.now()}-${buildCounter}`;
  const previous = child;
  const launch = () => {
    if (closing) return;
    console.log(`[dev] starting MCP server (${reason}, build ${buildId})`);
    const started = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: "development",
        CPTR_HOT_RELOAD: "1",
        CPTR_DEV_BUILD_ID: buildId,
      },
      stdio: "inherit",
    });
    child = started;
    started.on("exit", (code, signal) => {
      if (child === started) child = null;
      if (!closing && code && code !== 0) {
        console.error(`[dev] MCP server exited with code ${code}${signal ? ` (${signal})` : ""}`);
      }
    });
  };

  if (previous && previous.exitCode === null) {
    previous.once("exit", launch);
    previous.kill("SIGTERM");
    setTimeout(() => {
      if (previous.exitCode === null) previous.kill("SIGKILL");
    }, 2_000).unref();
  } else {
    launch();
  }
}

function scheduleRestart(reason) {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => startServer(reason), 120);
}

const workbench = await context({
  entryPoints: [resolve(root, "web/src/workbench.tsx")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: "inline",
  minify: false,
  define: {
    "process.env.NODE_ENV": '"development"',
    __CPTR_APP_VERSION__: JSON.stringify(appVersion),
  },
  outfile: resolve(root, "web/dist/workbench.js"),
});

await workbench.watch();
console.log("[dev] watching Workbench sources; Workbench rebuilds hot-reload in place without restarting MCP");
startServer("initial startup");

const serverWatcher = watch(serverDirectory, { recursive: true }, (_eventType, filename) => {
  if (!filename || filename.endsWith("~") || filename.includes(".swp")) return;
  scheduleRestart(`server/${filename} changed`);
});
console.log("[dev] watching MCP server sources");

async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`[dev] shutting down (${signal})`);
  if (restartTimer) clearTimeout(restartTimer);
  serverWatcher.close();
  stopChild();
  await workbench.dispose();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void shutdown(signal).finally(() => process.exit(0));
  });
}
