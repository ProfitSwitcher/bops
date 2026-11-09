/**
 * Authenticated LAN proxy in front of a local Ollama, MLX, llama.cpp, or vLLM server.
 * The upstream stays on loopback. This process listens on one LAN address and checks a bearer token.
 *
 *   BOPS_LLM_PROXY_BIND=192.168.1.20 BOPS_LLM_PROXY_PORT=11435 BOPS_LLM_PROXY_TOKEN=... \
 *   BOPS_LLM_UPSTREAM=http://127.0.0.1:11434 node workers/bops-llm-proxy.mjs
 */
import { createServer, request as httpRequest } from "node:http";
import { timingSafeEqual } from "node:crypto";
import net from "node:net";

function refuseBind(bind) {
  if (!bind || bind === "0.0.0.0" || bind === "::") return "Refusing to listen on every interface.";
  if (net.isIP(bind) && !["127.0.0.1", "::1"].includes(bind)) {
    const p = bind.split(".").map(Number);
    const lan = p[0] === 10 || (p[0] === 192 && p[1] === 168) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
    if (!lan) return `Refusing to listen on ${bind}.`;
  }
  return "";
}

function tokenOk(header, token) {
  const got = (header || "").startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || got.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(token));
}

export function startProxy(opts = {}) {
  const bind = opts.bind ?? process.env.BOPS_LLM_PROXY_BIND ?? "127.0.0.1";
  const why = refuseBind(bind);
  if (why) throw new Error(why);
  const token = opts.token ?? process.env.BOPS_LLM_PROXY_TOKEN ?? "";
  if (!token) throw new Error("BOPS_LLM_PROXY_TOKEN is required.");
  const upstream = new URL(opts.upstream ?? process.env.BOPS_LLM_UPSTREAM ?? "http://127.0.0.1:11434");
  if (!["127.0.0.1", "localhost", "::1"].includes(upstream.hostname)) throw new Error("The proxy only forwards to a loopback upstream.");
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (!tokenOk(req.headers.authorization, token)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    const headers = { ...req.headers, host: upstream.host };
    delete headers.authorization;
    const proxied = httpRequest(
      { protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
      },
    );
    proxied.on("error", () => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "The local model server didn't answer." }));
    });
    req.pipe(proxied);
  });
  const port = Number(opts.port ?? process.env.BOPS_LLM_PROXY_PORT ?? 11435);
  return new Promise((resolve) =>
    server.listen(port, bind, () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : port, bind });
    }),
  );
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  startProxy()
    .then(({ bind, port }) => console.log(`bops llm proxy on http://${bind}:${port}`))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
