import React from "react";
import type { DirectWorkerState } from "./state.js";

export type DirectWorkerTab = "activity" | "changes" | "terminal";

type Props = {
  workers: Record<string, DirectWorkerState>;
  workerOrder: string[];
  selectedWorkerId: string | null;
  selectedTab: DirectWorkerTab;
  connection: string;
  actionStatus: string;
  changesText: string;
  terminalText: string;
  onSelectWorker: (workerId: string) => void;
  onSelectTab: (tab: DirectWorkerTab) => void;
  onRefreshChanges: () => void;
  onRefreshTerminal: () => void;
  onPin: () => void;
  onExpand: () => void;
  onStopCommand?: () => void;
  canStopCommand?: boolean;
  updateCenter?: React.ReactNode;
};

function statusClass(status: string): string {
  const value = status.toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
  return `worker-status-${value || "ready"}`;
}

function activeStatus(status: string): boolean {
  return ["RUNNING", "WORKING", "CONNECTING"].includes(status.toUpperCase());
}

function displayTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function DirectWorkersView({
  workers,
  workerOrder,
  selectedWorkerId,
  selectedTab,
  connection,
  actionStatus,
  changesText,
  terminalText,
  onSelectWorker,
  onSelectTab,
  onRefreshChanges,
  onRefreshTerminal,
  onPin,
  onExpand,
  onStopCommand,
  canStopCommand = false,
  updateCenter,
}: Props) {
  const orderedWorkers = workerOrder.map((id) => workers[id]).filter(Boolean);
  const selected = (selectedWorkerId && workers[selectedWorkerId]) || orderedWorkers[0] || null;
  const activeCount = orderedWorkers.filter((worker) => activeStatus(worker.status)).length;
  const completeCount = orderedWorkers.filter((worker) => ["COMPLETE", "INTEGRATED"].includes(worker.status)).length;

  return <section className="worker-card" aria-label="CPTR Direct Coding Workers">
    <header className="worker-header">
      <div className="worker-heading">
        <span className="terminal-mark" aria-hidden="true">CP</span>
        <div>
          <strong>Direct Coding Workers</strong>
          <span>{orderedWorkers.length} workers · {activeCount} active · {completeCount} complete</span>
        </div>
      </div>
      <span className="worker-connection"><span className="status-dot" />{connection}</span>
    </header>

    {updateCenter}

    <div className="worker-lanes" role="tablist" aria-label="Direct coding workers">
      {orderedWorkers.map((worker) => <button
        type="button"
        key={worker.workerId}
        className={`worker-lane ${selected?.workerId === worker.workerId ? "selected" : ""}`}
        onClick={() => onSelectWorker(worker.workerId)}
        role="tab"
        aria-selected={selected?.workerId === worker.workerId}
      >
        <span className={`worker-dot ${statusClass(worker.status)}`} aria-hidden="true" />
        <span className="worker-lane-copy">
          <strong>{worker.name}</strong>
          <span>{worker.responsibility || "Direct coding"}</span>
          <small>{worker.summary || worker.status}</small>
        </span>
        <span className="worker-lane-meta">
          <b>{worker.status}</b>
          <small>{worker.changedFileCount} changed</small>
        </span>
      </button>)}
    </div>

    {selected ? <>
      <div className="worker-tabs" role="tablist" aria-label={`${selected.name} details`}>
        {(["activity", "changes", "terminal"] as DirectWorkerTab[]).map((tab) => <button
          type="button"
          key={tab}
          className={selectedTab === tab ? "selected" : ""}
          onClick={() => onSelectTab(tab)}
          role="tab"
          aria-selected={selectedTab === tab}
        >{tab[0].toUpperCase() + tab.slice(1)}</button>)}
      </div>

      <div className="worker-detail" role="tabpanel">
        {selectedTab === "activity" ? <div className="worker-activity">
          {selected.activity.length ? [...selected.activity].reverse().map((item) => <div className="worker-activity-row" key={item.id}>
            <time>{displayTime(item.timestamp)}</time>
            <span className={`worker-dot ${statusClass(item.status)}`} aria-hidden="true" />
            <div><strong>{item.status}</strong><span>{item.summary}</span></div>
          </div>) : <div className="worker-empty">No worker activity yet.</div>}
        </div> : null}

        {selectedTab === "changes" ? <div className="worker-pane">
          <div className="worker-pane-heading">
            <div><strong>Changed files</strong><span>{selected.changedFileCount} currently changed in this isolated worktree.</span></div>
            <button type="button" onClick={onRefreshChanges}>Refresh</button>
          </div>
          <pre>{changesText || (selected.changedPaths.length ? selected.changedPaths.join("\n") : "No changed files.")}</pre>
        </div> : null}

        {selectedTab === "terminal" ? <div className="worker-pane">
          <div className="worker-pane-heading">
            <div><strong>Recent command tail</strong><span>Loaded on demand; raw terminal output is not continuously streamed.</span></div>
            <div className="worker-pane-actions">
              {onStopCommand ? <button type="button" className="danger" disabled={!canStopCommand} onClick={onStopCommand}>Stop</button> : null}
              <button type="button" onClick={onRefreshTerminal}>Refresh tail</button>
            </div>
          </div>
          <pre className="worker-terminal">{terminalText || "No command output loaded."}</pre>
        </div> : null}
      </div>
    </> : <div className="worker-empty">Waiting for ChatGPT to create a Direct Coding Worker.</div>}

    <footer className="worker-footer">
      <span className="action-status">{actionStatus || "ChatGPT remains the sole reasoning model."}</span>
      <div><button type="button" onClick={onPin}>Pin</button><button type="button" onClick={onExpand}>Expand</button></div>
    </footer>
  </section>;
}
