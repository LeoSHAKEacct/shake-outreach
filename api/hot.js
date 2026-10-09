import { scoreHot } from "./_hot_score.js";
import { requireUser, rateLimited, send, readBody, clip } from "./_claude.js";
import { hotDaysLeft } from "./_account.js";
import { makeTicket, readTicket } from "./_apify.js";
import { writeQueries, startHotRuns, collectRuns } from "./_hot_core.js";
import { digestStart, digestSend, setWatch } from "./_digest.js";

// Hot leads: people posting right now that they need what the user sells.
// POST {summary, segment, location} -> Claude writes searches, Apify scans Reddit and X.
// GET ?ticket= -> status + the posts found so far (scored separately by /api/hot-score).
// POST ?watch=1 -> turn the weekly email on or off. /api/hot-digest/start|send -> the weekly cron jobs.
export default async function handler(req, res) {
  const path = String(req.url || "").split("?")[0];
  const digest = (req.query && req.query.digest) || (path.match(/\/api\/hot-digest\/([a-z]+)/) || [])[1];
  if (digest) return digest === "start" ? digestStart(req, res) : digestSend(req, res);
  if (req.query && req.query.score) return scoreHot(req, res);
  if (!process.env.APIFY_TOKEN) return send(res, 503, { error: "missing_apify" });
  const user = await requireUser(req);
  if (!user || !user.id) return send(res, 401, { error: "auth_required" });
  if (req.query && req.query.watch) return setWatch(req, res, user);

  if (req.method === "POST") {
    const left = hotDaysLeft(user);
    if (left !== null && left <= 0) return send(res, 402, { error: "hot_trial_over" });
    if (rateLimited(req, user, 4)) return send(res, 429, { error: "rate_limited" });
    const b = readBody(req);
    const summary = clip(b.summary, 400), segment = clip(b.segment, 120), location = clip(b.location, 80);
    if (!summary) return send(res, 400, { error: "no_query" });

    let q;
    try { q = await writeQueries(summary, segment, location); }
    catch (e) { return send(res, 502, { error: e.code || "upstream_error" }); }

    const parts = await startHotRuns(q);
    if (parts[0] === "-" && parts[2] === "-") return send(res, 502, { error: "apify_error" });
    return send(res, 200, { ticket: makeTicket([...parts, user.id]), queries: q });
  }

  if (req.method === "GET") {
    const url = new URL(req.url, "http://x");
    const t = readTicket(url.searchParams.get("ticket"), 5);
    if (!t || t[4] !== user.id) return send(res, 403, { error: "bad_ticket" });
    return send(res, 200, await collectRuns(t.slice(0, 4)));
  }

  return send(res, 405, { error: "method" });
}
