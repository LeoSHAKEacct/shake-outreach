import { apify, startRun, makeTicket, readTicket } from "./_apify.js";
import { requireUser, rateLimited, send, readBody, clip } from "./_claude.js";
import { account, updateAppMeta, tracking, paidSource, spendPatch, LEAD_PRICE } from "./_account.js";
import { freeLeads } from "./_free_leads.js";
import { readLeads, writeLeads, seenSet, isSeen, sameSearch } from "./_lead_store.js";

// Real leads from Google Maps via Apify's Google Maps Scraper.
// POST {query, location} starts a run and returns a signed ticket;
// GET ?ticket=... returns the run status and the leads found so far.
const ACTOR = "compass~crawler-google-places";
const MAX_PLACES = 20;
const MAX_SCAN = 120;   // how deep we look into Google Maps to get past leads you already have

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

// Keep only leads this user has never seen, at most `max`, and save them to their lead history.
async function keepNew(user, leads, { runId, q, loc, site, max, save }) {
  const store = await readLeads(user.id);
  if (store.runs.includes(runId)) {
    // Already saved (a repeat poll): give back exactly what this search found.
    return { leads: store.leads.filter(l => l.run === runId), skipped: 0 };
  }
  const seen = seenSet(store.leads);
  const fresh = [], again = new Set();
  for (const l of leads) {
    if (isSeen(seen, l)) { again.add(l.name); continue; }
    if (fresh.length >= max) break;
    fresh.push(l);
    for (const k of seenSet([l])) seen.add(k);
  }
  if (save) {
    const at = Date.now();
    const rows = fresh.map(l => ({ ...l, q, loc, site, at, run: runId }));
    await writeLeads(user.id, { leads: [...rows, ...store.leads], runs: [...store.runs, runId] }).catch(() => {});
  }
  return { leads: fresh, skipped: again.size };
}

export default async function handler(req, res) {
  const user = await requireUser(req);
  if (!user || !user.id) return send(res, 401, { error: "auth_required" });
  // Everything this user has found, newest first (the "My leads" page).
  if (req.method === "GET" && /[?&]history=1/.test(req.url || "")) {
    const { leads } = await readLeads(user.id);
    return send(res, 200, { leads: leads.map(({ run, ...l }) => l) });
  }
  const paid = paidSource(user);
  if (paid && !process.env.APIFY_TOKEN) return send(res, 503, { error: "missing_apify" });

  if (req.method === "POST") {
    if (rateLimited(req, user, 5)) return send(res, 429, { error: "rate_limited" });
    const b = readBody(req);
    const query = clip(b.query, 80), location = clip(b.location, 80);
    if (!query) return send(res, 400, { error: "no_query" });
    if (!location) return send(res, 400, { error: "no_location" });
    const site = clip(b.site, 120);
    const acct = account(user);
    const affordable = tracking() ? Math.floor(acct.credits_left / LEAD_PRICE + 1e-9) : MAX_PLACES;
    if (affordable < 1) return send(res, 402, { error: "no_credits" });
    const want = Math.min(MAX_PLACES, affordable);
    // Look past the leads this user already has for this same search, so the new ones are new.
    const stored = (await readLeads(user.id)).leads;
    const had = stored.filter(l => sameSearch(l, query, location)).length;
    const scan = Math.min(MAX_SCAN, want + had);

    // Trial accounts: free open data (OpenStreetMap + our own email finder), answered right away.
    if (!paid) {
      try {
        const tags = Array.isArray(b.osm) ? b.osm.map(t => clip(t, 60)).slice(0, 5) : [];
        const runId = "free-" + Date.now();
        const seen = seenSet(stored);
        const all = await freeLeads({ tags, term: query, location, max: want, skip: l => isSeen(seen, l) });
        const { leads, skipped } = await keepNew(user, all, { runId, q: query, loc: location, site, max: want, save: true });
        const acct2 = await charge(user, leads, runId);
        return send(res, 200, { status: "SUCCEEDED", leads, skipped, account: acct2, source: "free" });
      } catch (e) {
        return send(res, 502, { error: (e && e.code) || "free_source_busy" });
      }
    }
    try {
      const run = await startRun(ACTOR, {
          searchStringsArray: [query],
          locationQuery: location,
          maxCrawledPlacesPerSearch: scan,
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
    const q = clip(url.searchParams.get("q"), 80), loc = clip(url.searchParams.get("loc"), 80), site = clip(url.searchParams.get("site"), 120);
    if (!parts || parts[2] !== user.id) return send(res, 403, { error: "bad_ticket" });
    const t = { runId: parts[0], datasetId: parts[1] };
    try {
      const [run, items] = await Promise.all([
        apify(`/actor-runs/${t.runId}`),
        apify(`/datasets/${t.datasetId}/items?clean=true&limit=${MAX_SCAN}`),
      ]);
      const status = (run.data && run.data.status) || "RUNNING";
      const all = (Array.isArray(items) ? items : []).map(toLead).filter(l => l.name);
      const done = ["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(status);
      const a0 = account(user);
      const max = Math.min(MAX_PLACES, tracking() ? Math.max(0, Math.floor(a0.credits_left / LEAD_PRICE + 1e-9)) : MAX_PLACES);
      const charged = ((user.app_metadata || {}).charged_runs || []).includes(t.runId);
      const { leads, skipped } = await keepNew(user, all, { runId: t.runId, q, loc, site, max: charged ? MAX_PLACES : max, save: done });
      const acct = done ? await charge(user, leads, t.runId) : a0;
      return send(res, 200, { status, leads, skipped, account: acct });
    } catch {
      return send(res, 502, { error: "apify_error" });
    }
  }

  return send(res, 405, { error: "method" });
}
