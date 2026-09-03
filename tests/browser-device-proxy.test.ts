import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { connect as connectTcp } from "node:net";
import test from "node:test";
import {
  isBrowserDevicePath,
  proxyBrowserDeviceHttp,
  proxyBrowserDeviceUpgrade,
} from "../server/browser-device-proxy.js";

const extensionOrigin = "chrome-extension://jgffclmbhhlgoloondkchodehenicfbl";

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("server did not bind a TCP port"));
      resolve(address.port);
    });
  });
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

test("recognizes only the browser-device API prefix", () => {
  assert.equal(isBrowserDevicePath("/api/browser-device/v1"), true);
  assert.equal(isBrowserDevicePath("/api/browser-device/v1/pairing/request"), true);
  assert.equal(isBrowserDevicePath("/api/browser-device/v10/pairing/request"), false);
  assert.equal(isBrowserDevicePath("/mcp"), false);
});

test("HTTP browser-device proxy strips ambient auth and upstream CORS", async () => {
  let seenHeaders: IncomingMessage["headers"] = {};
  let seenBody = "";
  const upstream = createServer((req, res) => {
    void (async () => {
      seenHeaders = req.headers;
      seenBody = await readBody(req);
      res.writeHead(200, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "set-cookie": "should-not-cross=1",
      }).end(JSON.stringify({ pairing_id: "pair_1" }));
    })();
  });
  const upstreamPort = await listen(upstream);

  const proxy = createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", extensionOrigin);
    void proxyBrowserDeviceHttp(req, res, `http://127.0.0.1:${upstreamPort}`);
  });
  const proxyPort = await listen(proxy);

  try {
    const response = await new Promise<{ status: number; headers: IncomingMessage["headers"]; body: string }>((resolve, reject) => {
      const request = httpRequest({
        host: "127.0.0.1",
        port: proxyPort,
        path: "/api/browser-device/v1/pairing/request",
        method: "POST",
        headers: {
          Origin: extensionOrigin,
          "Content-Type": "application/json",
          Authorization: "Bearer must-not-cross",
          Cookie: "session=must-not-cross",
          "Cf-Access-Jwt-Assertion": "must-not-cross",
        },
      }, (res) => {
        void (async () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: await readBody(res) }))();
      });
      request.once("error", reject);
      request.end(JSON.stringify({ device_name: "Heidi Chrome" }));
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers["access-control-allow-origin"], extensionOrigin);
    assert.equal(response.headers["set-cookie"], undefined);
    assert.deepEqual(JSON.parse(response.body), { pairing_id: "pair_1" });
    assert.equal(seenHeaders.origin, extensionOrigin);
    assert.equal(seenHeaders.authorization, undefined);
    assert.equal(seenHeaders.cookie, undefined);
    assert.equal(seenHeaders["cf-access-jwt-assertion"], undefined);
    assert.deepEqual(JSON.parse(seenBody), { device_name: "Heidi Chrome" });
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("WebSocket browser-device proxy tunnels upgrade without ambient credentials", async () => {
  let upstreamHeaders: IncomingMessage["headers"] = {};
  const upstream = createServer();
  upstream.on("upgrade", (req, socket) => {
    upstreamHeaders = req.headers;
    socket.end(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: test-accept\r\n\r\n" +
      "proxied",
    );
  });
  const upstreamPort = await listen(upstream);

  const proxy = createServer();
  proxy.on("upgrade", (req, socket, head) => {
    proxyBrowserDeviceUpgrade(req, socket, head, `http://127.0.0.1:${upstreamPort}`);
  });
  const proxyPort = await listen(proxy);

  try {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connectTcp(proxyPort, "127.0.0.1");
      let data = "";
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("timed out waiting for proxied WebSocket upgrade"));
      }, 2_000);
      socket.once("error", reject);
      socket.on("data", (chunk) => {
        data += chunk.toString("utf8");
        if (data.includes("proxied")) {
          clearTimeout(timer);
          socket.destroy();
          resolve(data);
        }
      });
      socket.once("connect", () => {
        socket.write(
          "GET /api/browser-device/v1/connect/control HTTP/1.1\r\n" +
          `Host: 127.0.0.1:${proxyPort}\r\n` +
          `Origin: ${extensionOrigin}\r\n` +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          "Sec-WebSocket-Key: dGVzdC10ZXN0LXRlc3Q=\r\n" +
          "Authorization: Bearer must-not-cross\r\n" +
          "Cookie: must-not-cross=1\r\n\r\n",
        );
      });
    });

    assert.match(response, /101 Switching Protocols/);
    assert.match(response, /proxied/);
    assert.equal(upstreamHeaders.origin, extensionOrigin);
    assert.equal(upstreamHeaders.authorization, undefined);
    assert.equal(upstreamHeaders.cookie, undefined);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});
