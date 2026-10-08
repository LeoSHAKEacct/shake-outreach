import crypto from "node:crypto";
import { requireUser, rateLimited, send, readBody, clip } from "./_claude.js";
import { account, updateAppMeta, tracking, LEAD_PRICE } from "./_account.js";

// Real leads from Google Maps via Apify's Google Maps Scraper.
// POST {query, location} starts a run and returns a signed ticket;
// GET ?ticket=... returns the run status and the leads found so far.
const ACTOR = "compass~crawler-google-places";
const API = "https://api.apify.com/v2";
const MAX_PLACES = 20;

function sign(payload) {
  return crypto.createHmac("sha256", process.env.APIFY_TOKEN).update(payload).digest("base64url");
}
function makeTicket(runId, datasetId, uid) {
  const payload = [runId, datasetId, uid].join(".");
  return payload + "." + sign(payload);
}
function readTicket(ticket) {
  const parts = String(ticket || "").split(".");
  if (parts.length !== 4) return null;
  const payload = parts.slice(0, 3).join(".");
  const a = Buffer.from(sign(payload)), b = Buffer.from(parts[3]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { runId: parts[0], datasetId: parts[1], uid: parts[2] };
}

async function apify(path, init = {}) {
  const r = await fetch(API + path, {
    ...init,
    headers: { Authorization: "Bearer " + process.env.APIFY_TOKEN, "Content-Type": "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(15000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw { status: r.status, data };
  return data;
}

function toLead(p) {
  const emails = [].concat(p.emails || [], p.email || []).filter(e => typeof e === "string" && e.includes("@"));
  return {
    name: String(p.title || p.name || ""),
    email: emails[0] || "",
    phone: String(p.phone || p.phoneUnformatted || ""),
    website: String(p.website || ""),
    address: String(p.address || ""),
    rating: typeof p.totalScore === "number" ? p.totalScore : null,
    maps: String(p.url || ""),
  };
}

export default async function handler(req, res) {
  if (!process.env.APIFY_TOKEN) return send(res, 503, { error: "missing_apify" });
  const user = await requireUser(req);
  if (!user || !user.id) return send(res, 401, { error: "auth_required" });

  if (req.method === "POST") {
    if (rateLimited(req, user, 5)) return send(res, 429, { error: "rate_limited" });
    const b = readBody(req);
    const query = clip(b.query, 80), location = clip(b.location, 80);
    if (!query) return send(res, 400, { error: "no_query" });
    if (!location) return send(res, 400, { error: "no_location" });
    const acct = account(user);
    const affordable = tracking() ? Math.floor(acct.credits_left / LEAD_PRICE + 1e-9) : MAX_PLACES;
    if (affordable < 1) return send(res, 402, { error: "no_credits" });
    try {
      const run = await apify(`/acts/${ACTOR}/runs`, {
        method: "POST",
        body: JSON.stringify({
          searchStringsArray: [query],
          locationQuery: location,
          maxCrawledPlacesPerSearch: Math.min(MAX_PLACES, affordable),
          language: "en",
          website: "withWebsite",
          skipClosedPlaces: true,
          scrapeContacts: true,
        }),
      });
      const d = run.data || {};
      return send(res, 200, { ticket: makeTicket(d.id, d.defaultDatasetId, user.id) });
    } catch (e) {
      return send(res, 502, { error: e.status === 402 ? "apify_credits" : "apify_error" });
    }
  }

  if (req.method === "GET") {
    const url = new URL(req.url, "http://x");
    const t = readTicket(url.searchParams.get("ticket"));
    if (!t || t.uid !== user.id) return send(res, 403, { error: "bad_ticket" });
    try {
      const [run, items] = await Promise.all([
        apify(`/actor-runs/${t.runId}`),
        apify(`/datasets/${t.datasetId}/items?clean=true&limit=${MAX_PLACES}`),
      ]);
      const status = (run.data && run.data.status) || "RUNNING";
      const leads = (Array.isArray(items) ? items : []).map(toLead).filter(l => l.name);
      let acct = account(user);
      // Charge once per finished run, only for leads that came with an email.
      const done = ["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(status);
      const charged = (user.app_metadata && user.app_metadata.charged_runs) || [];
      if (done && tracking() && !charged.includes(t.runId)) {
        const billable = leads.filter(l => l.email).length;
        const m = user.app_metadata || {};
        try {
          const updated = await updateAppMeta(user, {
            credits_used: +(Number(m.credits_used || 0) + billable * LEAD_PRICE).toFixed(2),
            leads_found: Number(m.leads_found || 0) + billable,
            charged_runs: [...charged, t.runId].slice(-50),
          });
          if (updated) acct = account(updated);
        } catch {}
      }
      return send(res, 200, { status, leads, account: acct });
    } catch {
      return send(res, 502, { error: "apify_error" });
    }
  }

  return send(res, 405, { error: "method" });
}
