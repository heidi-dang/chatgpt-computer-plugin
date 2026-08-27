import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type WorkbenchAssets = {
  bundle: string;
  styles: string;
  ready: boolean;
  directory: string | null;
  searchedDirectories: string[];
};

export type WorkbenchHotReload = {
  enabled: boolean;
  buildId: string;
};

type Environment = Record<string, string | undefined>;

export function resolveWorkbenchHotReload(
  assets: Pick<WorkbenchAssets, "bundle" | "styles">,
  env: Environment = process.env,
): WorkbenchHotReload {
  const configured = env.CPTR_HOT_RELOAD?.trim().toLowerCase();
  const enabled = configured === undefined || !["0", "false", "off", "no"].includes(configured);
  const assetHash = createHash("sha256")
    .update(assets.bundle)
    .update("\0")
    .update(assets.styles)
    .digest("hex")
    .slice(0, 24);
  const release = (
    env.CPTR_WORKBENCH_BUILD_ID ??
    env.CPTR_DEV_BUILD_ID ??
    env.GIT_COMMIT_SHA ??
    env.RAILWAY_GIT_COMMIT_SHA ??
    ""
  )
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .slice(0, 64);
  return {
    enabled,
    buildId: release ? `${release}-${assetHash}` : assetHash,
  };
}

type AssetLoaderOptions = {
  moduleUrl?: string;
  cwd?: string;
  bundleDirectory?: string;
};

function uniqueDirectories(values: string[]): string[] {
  return [...new Set(values.map((value) => resolve(value)))];
}

export function workbenchAssetDirectories(options: AssetLoaderOptions = {}): string[] {
  const moduleUrl = options.moduleUrl ?? import.meta.url;
  const cwd = options.cwd ?? process.cwd();
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  const configured = options.bundleDirectory ?? process.env.CPTR_WORKBENCH_ASSET_DIR;
  return uniqueDirectories([
    ...(configured ? [configured] : []),
    // `tsx server/index.ts`: repository/server -> repository/web/dist.
    resolve(moduleDirectory, "../web/dist"),
    // `node dist/server/index.js`: repository/dist/server -> repository/web/dist.
    resolve(moduleDirectory, "../../web/dist"),
    // Deployment runtimes commonly preserve a repository-root working directory.
    resolve(cwd, "web/dist"),
    // `npm run build` copies assets alongside the compiled server for artifact-only images.
    resolve(cwd, "dist/web/dist"),
  ]);
}

export function loadWorkbenchAssets(options: AssetLoaderOptions = {}): WorkbenchAssets {
  const searchedDirectories = workbenchAssetDirectories(options);
  for (const directory of searchedDirectories) {
    const bundlePath = resolve(directory, "workbench.js");
    const stylesPath = resolve(directory, "workbench.css");
    if (!existsSync(bundlePath) || !existsSync(stylesPath)) continue;
    return {
      bundle: readFileSync(bundlePath, "utf8"),
      styles: readFileSync(stylesPath, "utf8"),
      ready: true,
      directory,
      searchedDirectories,
    };
  }
  return {
    bundle: "document.body.textContent = 'CPTR Live Workbench bundle is not built';",
    styles: "",
    ready: false,
    directory: null,
    searchedDirectories,
  };
}
