import Anthropic from "@anthropic-ai/sdk";
import dns from "node:dns/promises";
import net from "node:net";

const MODEL = "claude-opus-5-5";
const client = new Anthropic();

// --- tiny per-instance rate limit (best effort; resets when the function cold-starts) ---
const hits = new Map();
export function rateLimited(req, limit = 20, windowMs = 10 * 60 * 1000) {
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < windowMs);
  list.push(now);
  hits.set(ip, list);
  return list.length > limit;
}

export function send(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body || "{}"); } catch { return {}; }
}

export const clip = (v, n) => String(v ?? "").slice(0, n).trim();

// Ask Claude for JSON that matches `schema`. Throws {code} on failure.
export async function askJSON(prompt, schema, effort) {
  if (!process.env.ANTHROPIC_API_KEY) throw { code: "missing_key" };
  let response;
  try {
    response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort, format: { type: "json_schema", schema } },
      messages: [{ role: "user", content: prompt }],
    });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) throw { code: "rate_limited" };
    if (e instanceof Anthropic.AuthenticationError) throw { code: "bad_key" };
    if (e instanceof Anthropic.APIError) throw { code: "upstream_error", detail: e.message };
    throw { code: "upstream_error" };
  }
  if (response.stop_reason === "refusal") throw { code: "refused" };
  const text = response.content.filter(b => b.type === "text").map(b => b.text).join("");
  try { return JSON.parse(text); } catch { throw { code: "invalid_json" }; }
}

// --- fetch a public website's text, refusing private/internal addresses ---
function isPrivate(ip) {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return isPrivate(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
         (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

async function safeUrl(raw) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) return null;
  try {
    const addrs = await dns.lookup(u.hostname, { all: true });
    if (!addrs.length || addrs.some(a => isPrivate(a.address))) return null;
  } catch { return null; }
  return u;
}

export async function fetchSiteText(raw) {
  let url = await safeUrl(raw);
  for (let hop = 0; url && hop < 4; hop++) {
    let r;
    try {
      r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(8000),
        headers: { "User-Agent": "Mozilla/5.0 (compatible; ShakeOutreachBot/1.0)", "Accept": "text/html" } });
    } catch { return ""; }
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      url = await safeUrl(new URL(r.headers.get("location"), url).toString());
      continue;
    }
    if (!r.ok || !/text\/html|text\/plain/i.test(r.headers.get("content-type") || "")) return "";
    const html = (await r.text()).slice(0, 1_500_000);
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
    const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i) || [])[1] || "";
    const body = html
      .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
      .replace(/\s+/g, " ").trim();
    return [title && "Title: " + title, desc && "Description: " + desc, body].filter(Boolean).join("\n").slice(0, 12000);
  }
  return "";
}
