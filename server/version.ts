import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type PackageMetadata = {
  name?: unknown;
  version?: unknown;
};

const PACKAGE_NAME = "chatgpt-computer-plugin";
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function packageJsonCandidates(): string[] {
  return [
    resolve(process.cwd(), "package.json"),
    fileURLToPath(new URL("../package.json", import.meta.url)),
    fileURLToPath(new URL("../../package.json", import.meta.url)),
  ];
}

function readCanonicalPackageVersion(): string {
  const seen = new Set<string>();
  for (const candidate of packageJsonCandidates()) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      const metadata = JSON.parse(readFileSync(candidate, "utf8")) as PackageMetadata;
      if (metadata.name !== PACKAGE_NAME || typeof metadata.version !== "string") continue;
      const version = metadata.version.trim();
      if (!SEMVER_PATTERN.test(version)) {
        throw new Error(`Invalid ${PACKAGE_NAME} semantic version: ${version}`);
      }
      return version;
    } catch (error) {
      if (error instanceof SyntaxError) throw error;
      if (error instanceof Error && error.message.startsWith("Invalid ")) throw error;
    }
  }
  throw new Error(`Unable to resolve ${PACKAGE_NAME} version from package.json`);
}

/**
 * Canonical CPTR Computer application version.
 *
 * package.json is the single source of truth. ServerInfo, the MCP contract,
 * Update Center, health metadata, release verification, and the Workbench
 * browser bundle all derive from this value rather than carrying independent
 * hard-coded versions.
 */
export const CPTR_APP_VERSION = readCanonicalPackageVersion();
