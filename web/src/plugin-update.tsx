import React, { useCallback, useEffect, useRef, useState } from "react";

export type PluginUpdateManifest = {
  product: string;
  version: string;
  schema_revision: string;
  contract_version: string;
  tool_count: number;
  release_sha: string | null;
  released_at: string;
  summary: string;
  changes: string[];
  refresh_required: boolean;
  refresh_reason: string;
  refresh_path: string[];
  verification: {
    tool: string;
    arguments: Record<string, unknown>;
  };
};

type UpdatePhase = "checking" | "current" | "update_available" | "error";
type CallTool = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export type PluginUpdateCenterProps = {
  callTool: CallTool;
  manifestUrl?: string;
  onStatus?: (message: string) => void;
};

function findManifest(value: unknown): PluginUpdateManifest | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.product === "string" &&
    typeof record.version === "string" &&
    typeof record.schema_revision === "string" &&
    typeof record.contract_version === "string" &&
    typeof record.tool_count === "number" &&
    Array.isArray(record.changes) &&
    Array.isArray(record.refresh_path) &&
    record.verification && typeof record.verification === "object"
  ) {
    return record as unknown as PluginUpdateManifest;
  }
  for (const key of ["structuredContent", "result", "toolResult", "data", "value"]) {
    const found = findManifest(record[key]);
    if (found) return found;
  }
  if (Array.isArray(record.content)) {
    for (const item of record.content) {
      if (!item || typeof item !== "object") continue;
      const text = (item as Record<string, unknown>).text;
      if (typeof text !== "string") continue;
      try {
        const found = findManifest(JSON.parse(text));
        if (found) return found;
      } catch {
        // Ignore non-JSON text content.
      }
    }
  }
  return null;
}

async function fetchManifest(url: string, signal?: AbortSignal): Promise<PluginUpdateManifest> {
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error(`update manifest unavailable (${response.status})`);
  return response.json() as Promise<PluginUpdateManifest>;
}

export function PluginUpdateCenter({ callTool, manifestUrl, onStatus }: PluginUpdateCenterProps) {
  const [manifest, setManifest] = useState<PluginUpdateManifest | null>(null);
  const [phase, setPhase] = useState<UpdatePhase>("checking");
  const [showNotes, setShowNotes] = useState(false);
  const lastRevision = useRef<string | null>(null);

  const verify = useCallback(async (candidate: PluginUpdateManifest) => {
    setPhase("checking");
    try {
      if (!candidate.refresh_required) {
        setPhase("current");
        onStatus?.(`CPTR Computer ${candidate.version} is current.`);
        return;
      }
      await callTool(candidate.verification.tool, candidate.verification.arguments);
      setPhase("current");
      onStatus?.(`CPTR Computer ${candidate.version} update verified.`);
    } catch {
      setPhase("update_available");
      onStatus?.(`CPTR Computer ${candidate.version} requires ChatGPT action refresh.`);
    }
  }, [callTool, onStatus]);

  const loadManifest = useCallback(async (signal?: AbortSignal): Promise<PluginUpdateManifest> => {
    try {
      const toolResult = await callTool("cptr_plugin_update", { action: "status" });
      const fromTool = findManifest(toolResult);
      if (fromTool) return fromTool;
      throw new Error("plugin update tool returned no manifest");
    } catch (toolError) {
      if (!manifestUrl) throw toolError;
      return fetchManifest(manifestUrl, signal);
    }
  }, [callTool, manifestUrl]);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;

    const refresh = async () => {
      try {
        const next = await loadManifest(controller.signal);
        if (disposed) return;
        setManifest(next);
        if (lastRevision.current !== next.schema_revision) {
          lastRevision.current = next.schema_revision;
          await verify(next);
        }
      } catch (error) {
        if (disposed || (error instanceof DOMException && error.name === "AbortError")) return;
        setPhase("error");
      }
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [loadManifest, verify]);

  const copySteps = async () => {
    if (!manifest) return;
    const text = `${manifest.refresh_path.join(" → ")}\nThen return to CPTR Computer and click Verify update.`;
    try {
      await navigator.clipboard.writeText(text);
      onStatus?.("CPTR update steps copied.");
    } catch {
      onStatus?.("Could not copy update steps.");
    }
  };

  if (!manifest && phase === "error") {
    return <aside className="plugin-update plugin-update-error" role="status">
      <div>
        <strong>Update status unavailable</strong>
        <span>CPTR could not read the release manifest through the update action or same-origin fallback.</span>
      </div>
    </aside>;
  }

  if (!manifest) return null;

  const updateAvailable = phase === "update_available";
  return <aside className={`plugin-update ${updateAvailable ? "plugin-update-required" : "plugin-update-current"}`} aria-label="CPTR plugin update status">
    <div className="plugin-update-heading">
      <div>
        <strong>{updateAvailable ? `Update available · ${manifest.version}` : `CPTR ${manifest.version}`}</strong>
        <span>{updateAvailable ? manifest.refresh_reason : phase === "checking" ? "Verifying ChatGPT action snapshot…" : "Update verified"}</span>
      </div>
      <span className="plugin-update-badge">{updateAvailable ? "REFRESH" : phase === "checking" ? "CHECKING" : "CURRENT"}</span>
    </div>

    {updateAvailable && <div className="plugin-update-path">
      <span>In ChatGPT:</span>
      <code>{manifest.refresh_path.join(" → ")}</code>
    </div>}

    <div className="plugin-update-actions">
      {updateAvailable && <button onClick={() => void verify(manifest)}>Verify update</button>}
      {updateAvailable && <button onClick={() => void copySteps()}>Copy update steps</button>}
      <button onClick={() => setShowNotes((value) => !value)}>{showNotes ? "Hide release notes" : "What’s new"}</button>
    </div>

    {showNotes && <div className="plugin-update-notes">
      <strong>{manifest.summary}</strong>
      <ul>{manifest.changes.map((change) => <li key={change}>{change}</li>)}</ul>
      <span>Contract {manifest.contract_version} · {manifest.tool_count} tools · released {manifest.released_at}</span>
    </div>}
  </aside>;
}
