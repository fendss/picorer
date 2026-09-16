import { createServer } from "node:http";
import { once } from "node:events";
import { Agent } from "undici";
import { describe, expect, it, vi } from "vitest";
import { fetchWithHttpTimeout, transportErrorMessage } from "../src/platform/http/runtime-fetch.js";

describe("runtime HTTP deadlines", () => {
  it("passes the configured deadline through native fetch to the HTTP dispatcher", async () => {
    const spy = vi.spyOn(Agent.prototype, "dispatch");
    const server = createServer((_request, response) => { response.end("OK"); });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      const address = server.address(); if (!address || typeof address === "string") throw Error("address");
      const response = await fetchWithHttpTimeout(`http://127.0.0.1:${address.port}`, {
        signal: AbortSignal.timeout(600000),
      }, 600000);
      expect(await response.text()).toBe("OK");
      expect(spy.mock.calls.some(([options]) => options.headersTimeout === 600000 && options.bodyTimeout === 600000)).toBe(true);
    } finally { spy.mockRestore(); server.closeAllConnections(); server.close(); await once(server, "close"); }
  });

  it("does not reuse an idle socket for the next inference POST", async () => {
    let connections = 0;
    const server = createServer((request, response) => { request.resume(); response.end("OK"); });
    server.on("connection", () => { connections += 1; });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      const address = server.address(); if (!address || typeof address === "string") throw Error("address");
      for (let i = 0; i < 2; i += 1) {
        const response = await fetchWithHttpTimeout(`http://127.0.0.1:${address.port}`, {
          method: "POST", body: "test", signal: AbortSignal.timeout(10000),
        }, 10000);
        expect(await response.text()).toBe("OK");
      }
      expect(connections).toBe(2);
    } finally { server.closeAllConnections(); server.close(); await once(server, "close"); }
  });

  it("keeps cancellation effective while consuming a stalled response body", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" }); response.flushHeaders(); response.write("partial");
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      const address = server.address(); if (!address || typeof address === "string") throw Error("address");
      const controller = new AbortController();
      const response = await fetchWithHttpTimeout(`http://127.0.0.1:${address.port}`, { signal: controller.signal }, 600000);
      const body = response.text(); controller.abort();
      await expect(body).rejects.toThrow();
    } finally { server.closeAllConnections(); server.close(); await once(server, "close"); }
  });

  it("retains the underlying network code and bounds cyclic error causes", () => {
    const cause = Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" });
    const outer = new TypeError("fetch failed", { cause });
    cause.cause = outer;
    expect(transportErrorMessage(outer)).toBe("fetch failed: Headers Timeout Error [UND_ERR_HEADERS_TIMEOUT]");
  });
});
