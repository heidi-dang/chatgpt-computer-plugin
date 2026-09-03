import React, { useEffect, useRef } from "react";

export type BrowserFrame = {
  id: string;
  dataUrl: string;
  width: number;
  height: number;
};

export type BrowserSurfaceProps = {
  frame: BrowserFrame | null;
  connection: string;
  mode: "OBSERVING" | "AGENT_CONTROL" | "HANDOFF_REQUIRED" | "HUMAN_CONTROL" | "DISCONNECTED";
  hostname?: string;
  actionLabel?: string;
};

export function BrowserSurface({ frame, connection, mode, hostname = "Chrome", actionLabel = "Waiting" }: BrowserSurfaceProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastFrameId = useRef<string | null>(null);

  useEffect(() => {
    if (!frame || frame.id === lastFrameId.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) return;
      const width = Math.max(1, frame.width);
      const height = Math.max(1, frame.height);
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      context.drawImage(image, 0, 0, width, height);
      lastFrameId.current = frame.id;
    };
    image.src = frame.dataUrl;
    return () => {
      cancelled = true;
      image.onload = null;
    };
  }, [frame]);

  const state = connection.toLowerCase().includes("reconnect")
    ? "reconnecting"
    : connection.toLowerCase().includes("live")
      ? "live"
      : "offline";

  return <section className="browser-shell" data-state={state} aria-label="CPTR live browser">
    <header className="browser-header">
      <div className="browser-identity">
        <div className="browser-kicker">CPTR LIVE COMPUTER · BROWSER</div>
        <div className="browser-machine-row">
          <span className="browser-machine">{hostname}</span>
          <span className="browser-status" data-state={state} role="status" aria-live="polite">
            <span className="state-dot" aria-hidden="true" />
            <span>{state.toUpperCase()}</span>
          </span>
        </div>
      </div>
      <span className="browser-mode">{mode.replaceAll("_", " ")}</span>
    </header>
    <div className="browser-frame" aria-live="off">
      <canvas ref={canvasRef} className="browser-canvas" />
      {!frame ? <div className="browser-empty">Waiting for browser frame…</div> : null}
    </div>
    <footer className="browser-footer">
      <span>{actionLabel}</span>
      <span>{mode}</span>
      <span className="browser-connection">{connection.toUpperCase()}</span>
    </footer>
  </section>;
}
