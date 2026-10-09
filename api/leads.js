import { apify, startRun, makeTicket, readTicket } from "./_apify.js";
import { requireUser, rateLimited, send, readBody, clip } from "./_claude.js";
import { account, updateAppMeta, tracking, paidSource, spendPatch, LEAD_PRICE } from "./_account.js";
import { freeLeads } from "./_free_leads.js";

// Real leads from Google Maps via Apify's Google Maps Scraper.
// POST {query, location} starts a run and returns a signed ticket;
// GET ?ticket=... returns the run status and the leads found so far.
const ACTOR = "compass~crawler-google-places";
const MAX_PLACES = 20;

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

async function charge(user, leads, runId) {
  const charged = (user.app_metadata && user.app_metadata.charged_runs) || [];
  if (!tracking() || charged.includes(runId)) return account(user);
  const billable = leads.filter(l => l.email).length;
  const m = user.app_metadata || {};
  try {
    const updated = await updateAppMeta(user, {
      ...spendPatch(user, billable * LEAD_PRICE),
      leads_found: Number(m.leads_found || 0) + billable,
      charged_runs: [...charged, runId].slice(-50),
    });
    return updated ? account(updated) : account(user);
  } catch { return account(user); }
}

export default async function handler(req, res) {
  const user = await requireUser(req);
  if (!user || !user.id) return send(res, 401, { error: "auth_required" });
  const paid = paidSource(user);
  if (paid && !process.env.APIFY_TOKEN) return send(res, 503, { error: "missing_apify" });

  if (req.method === "POST") {
    if (rateLimited(req, user, 5)) return send(res, 429, { error: "rate_limited" });
    const b = readBody(req);
    const query = clip(b.query, 80), location = clip(b.location, 80);
    if (!query) return send(res, 400, { error: "no_query" });
    if (!location) return send(res, 400, { error: "no_location" });
    const acct = account(user);
    const affordable = tracking() ? Math.floor(acct.credits_left / LEAD_PRICE + 1e-9) : MAX_PLACES;
    if (affordable < 1) return send(res, 402, { error: "no_credits" });

    // Trial accounts: free open data (OpenStreetMap + our own email finder), answered right away.
    if (!paid) {
      try {
        const tags = Array.isArray(b.osm) ? b.osm.map(t => clip(t, 60)).slice(0, 5) : [];
        const leads = await freeLeads({ tags, term: query, location, max: Math.min(MAX_PLACES, affordable) });
        const acct2 = await charge(user, leads, "free-" + Date.now());
        return send(res, 200, { status: "SUCCEEDED", leads, account: acct2, source: "free" });
      } catch (e) {
        return send(res, 502, { error: (e && e.code) || "free_source_busy" });
      }
    }
    try {
      const run = await startRun(ACTOR, {
          searchStringsArray: [query],
          locationQuery: location,
          maxCrawledPlacesPerSearch: Math.min(MAX_PLACES, affordable),
          language: "en",
          website: "withWebsite",
          skipClosedPlaces: true,
          scrapeContacts: true,
      });
      return send(res, 200, { ticket: makeTicket([run.runId, run.datasetId, user.id]) });
    } catch (e) {
      return send(res, 502, { error: e.status === 402 ? "apify_credits" : "apify_error" });
    }
  }

  if (req.method === "GET") {
    const url = new URL(req.url, "http://x");
    const parts = readTicket(url.searchParams.get("ticket"), 3);
    if (!parts || parts[2] !== user.id) return send(res, 403, { error: "bad_ticket" });
    const t = { runId: parts[0], datasetId: parts[1] };
    try {
      const [run, items] = await Promise.all([
        apify(`/actor-runs/${t.runId}`),
        apify(`/datasets/${t.datasetId}/items?clean=true&limit=${MAX_PLACES}`),
      ]);
      const status = (run.data && run.data.status) || "RUNNING";
      const leads = (Array.isArray(items) ? items : []).map(toLead).filter(l => l.name);
      const done = ["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(status);
      const acct = done ? await charge(user, leads, t.runId) : account(user);
      return send(res, 200, { status, leads, account: acct });
    } catch {
      return send(res, 502, { error: "apify_error" });
    }
  }

  return send(res, 405, { error: "method" });
}
