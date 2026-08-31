from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
import uvicorn


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Disposable CPTR MCP traffic acceptance harness")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--cptr-source", required=True)
    parser.add_argument("--control-token", required=True)
    parser.add_argument("--failure-control-token", required=True)
    return parser.parse_args()


ARGS = parse_args()
CPTR_SOURCE = Path(ARGS.cptr_source).resolve()
if not CPTR_SOURCE.is_dir():
    raise SystemExit(f"CPTR source directory does not exist: {CPTR_SOURCE}")
sys.path.insert(0, str(CPTR_SOURCE))

from cptr.services.mcp_traffic import McpTrafficBatch, McpTrafficStore  # noqa: E402

app = FastAPI()
store = McpTrafficStore(max_events=512, max_sessions=64, subscriber_queue_size=256)


def bearer_token(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "missing bearer token")
    return authorization[7:]


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/control/v1/workspaces")
async def list_workspaces(authorization: str | None = Header(default=None)) -> dict[str, list[object]]:
    token = bearer_token(authorization)
    if token not in {ARGS.control_token, ARGS.failure_control_token}:
        raise HTTPException(403, "invalid control token")
    return {"workspaces": []}


@app.post("/api/mcp/traffic/events")
async def ingest_traffic(
    request: Request,
    authorization: str | None = Header(default=None),
) -> dict[str, int]:
    token = bearer_token(authorization)
    if token == ARGS.failure_control_token:
        raise HTTPException(403, "mcp:traffic:write scope required")
    if token != ARGS.control_token:
        raise HTTPException(403, "invalid control token")
    payload = McpTrafficBatch.model_validate(await request.json())
    return await store.ingest(payload.events)


@app.get("/api/mcp/traffic/snapshot")
async def traffic_snapshot(request: Request) -> dict[str, object]:
    if not request.headers.get("cookie"):
        raise HTTPException(401, "admin cookie required")
    return await store.snapshot()


@app.get("/api/mcp/traffic/stream")
async def traffic_stream(request: Request) -> StreamingResponse:
    if not request.headers.get("cookie"):
        raise HTTPException(401, "admin cookie required")
    queue = store.subscribe()

    async def frames():
        try:
            snapshot = await store.snapshot()
            yield f"event: snapshot\ndata: {json.dumps(snapshot, separators=(',', ':'))}\n\n"
            while True:
                if await request.is_disconnected():
                    return
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=10.0)
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
                    continue
                yield f"event: traffic\ndata: {json.dumps(event, separators=(',', ':'))}\n\n"
        finally:
            store.unsubscribe(queue)

    return StreamingResponse(
        frames(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-store", "X-Accel-Buffering": "no"},
    )


if __name__ == "__main__":
    uvicorn.run(app, host=ARGS.host, port=ARGS.port, log_level="warning")
