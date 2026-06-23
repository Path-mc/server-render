/**
 * OpenClaw Telegram API Reverse Proxy
 * Deploy ke: Render.com (Free Tier) — bukan Cloudflare, pakai AWS IPs
 *
 * Render free tier spins down setelah 15 menit inaktif.
 * Keep-alive dikirim dari HF Space setiap 10 menit otomatis.
 */

import { createServer } from "node:http";
import { createRequire } from "node:module";

const TELEGRAM_BASE  = "https://api.telegram.org";
const PROXY_SECRET   = process.env.PROXY_SECRET ?? "";
const PORT           = parseInt(process.env.PORT ?? "10000", 10);
const MAX_BODY       = 50 * 1024 * 1024; // 50 MB (file upload Telegram)

console.log(`[proxy] Starting OpenClaw Telegram Proxy on :${PORT}`);
console.log(`[proxy] Secret auth: ${PROXY_SECRET ? "enabled" : "disabled (set PROXY_SECRET!)"}`);

createServer(async (req, res) => {
  const url = req.url ?? "/";

  // ── Health / Keep-alive endpoint ───────────────────────────
  if (url === "/" || url === "/health" || url === "/ping") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      ok:      true,
      service: "openclaw-tg-proxy",
      ts:      Date.now(),
    }));
  }

  // ── Auth check ─────────────────────────────────────────────
  if (PROXY_SECRET) {
    const clientSecret = req.headers["x-worker-secret"] ?? req.headers["x-proxy-secret"] ?? "";
    if (clientSecret !== PROXY_SECRET) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    }
  }

  // ── Path validation ────────────────────────────────────────
  if (!url.startsWith("/bot") && !url.startsWith("/file/bot")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "Invalid Telegram API path", path: url }));
  }

  // ── Read request body ──────────────────────────────────────
  let body = null;
  const isBodyless = req.method === "GET" || req.method === "HEAD";

  if (!isBodyless) {
    body = await new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", c => {
        size += c.length;
        if (size > MAX_BODY) reject(new Error("Body too large"));
        else chunks.push(c);
      });
      req.on("end",   () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    }).catch(() => null);
  }

  // ── Build headers for Telegram ─────────────────────────────
  const fwdHeaders = {};
  const STRIP = new Set(["host", "x-worker-secret", "x-proxy-secret", "connection",
    "keep-alive", "transfer-encoding", "upgrade", "proxy-authorization"]);

  for (const [k, v] of Object.entries(req.headers)) {
    if (!STRIP.has(k.toLowerCase())) fwdHeaders[k] = v;
  }
  fwdHeaders["host"] = "api.telegram.org";

  // ── Forward to Telegram ────────────────────────────────────
  const targetUrl = TELEGRAM_BASE + url;

  try {
    const fetchOpts = {
      method:  req.method,
      headers: fwdHeaders,
    };
    if (!isBodyless && body?.length > 0) {
      fetchOpts.body   = body;
      fetchOpts.duplex = "half";
    }

    const upRes   = await fetch(targetUrl, fetchOpts);
    const resBody = Buffer.from(await upRes.arrayBuffer());

    // Forward response headers (subset)
    const outHeaders = {
      "content-type":  upRes.headers.get("content-type") ?? "application/json",
      "content-length": String(resBody.length),
      "access-control-allow-origin": "*",
    };

    res.writeHead(upRes.status, outHeaders);
    res.end(resBody);

  } catch (err) {
    console.error("[proxy] Upstream error:", err.message);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Proxy upstream error", detail: err.message }));
  }

}).listen(PORT, "0.0.0.0", () => {
  console.log(`[proxy] Ready → forwarding to ${TELEGRAM_BASE}`);
});

