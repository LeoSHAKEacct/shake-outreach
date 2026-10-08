import { requireUser, askJSON, rateLimited, send, readBody, clip } from "./_claude.js";
import { hotDaysLeft } from "./_account.js";
import { apify, startRun, makeTicket, readTicket } from "./_apify.js";

// Hot leads: people posting right now that they need what the user sells.
// POST {summary, segment, location} -> Claude writes searches, Apify scans Reddit and X.
// GET ?ticket= -> status + the posts found so far (scored separately by /api/hot-score).
const REDDIT = "trudax~reddit-scraper-lite";
const X = "apidojo~tweet-scraper";

const QUERIES = {
  type: "object", additionalProperties: false, required: ["language", "reddit", "x"],
  properties: {
    language: { type: "string" },
    reddit: { type: "array", items: { type: "string" } },
    x: { type: "array", items: { type: "string" } },
  },
};

function fromReddit(p) {
  if (p.dataType && p.dataType !== "post") return null;
  const text = [p.title, p.body].filter(Boolean).join("\n").trim();
  if (!text || !p.url) return null;
  return { source: "Reddit", text: text.slice(0, 600), url: p.url, author: p.username || "", where: p.communityName || "", at: p.createdAt || "" };
}
function fromX(t) {
  if (!t.text || !t.url || t.isRetweet) return null;
  return { source: "X", text: String(t.text).slice(0, 600), url: t.url, author: (t.author && t.author.userName) || "", where: "", at: t.createdAt || "" };
}

export default async function handler(req, res) {
  if (!process.env.APIFY_TOKEN) return send(res, 503, { error: "missing_apify" });
  const user = await requireUser(req);
  if (!user || !user.id) return send(res, 401, { error: "auth_required" });

  if (req.method === "POST") {
    const left = hotDaysLeft(user);
    if (left !== null && left <= 0) return send(res, 402, { error: "hot_trial_over" });
    if (rateLimited(req, user, 4)) return send(res, 429, { error: "rate_limited" });
    const b = readBody(req);
    const summary = clip(b.summary, 400), segment = clip(b.segment, 120), location = clip(b.location, 80);
    if (!summary) return send(res, 400, { error: "no_query" });

    let q;
    try {
      q = await askJSON(`A business wants to find people who are asking online, right now, for what it sells.

Business: ${summary}
Customer type to focus on: ${segment || "any"}
Place: ${location || "anywhere"}

Write short search queries that would find posts where someone is actively looking for this kind of product or service: asking for recommendations, complaining about their current provider, or saying they need it. Use the language people in that place actually post in.
- language: ISO 639-1 code of that language.
- reddit: 3 plain search phrases (3-6 words each).
- x: 2 X/Twitter search queries (3-6 words each, you may use OR), add " -filter:retweets" at the end.`, QUERIES, "low");
    } catch (e) {
      return send(res, 502, { error: e.code || "upstream_error" });
    }

    const runs = await Promise.allSettled([
      startRun(REDDIT, { searches: q.reddit.slice(0, 3), searchPosts: true, searchComments: false, searchCommunities: false, searchUsers: false,
        sort: "new", time: "month", maxItems: 40, skipComments: true, includeNSFW: false }),
      startRun(X, { searchTerms: q.x.slice(0, 2), sort: "Latest", maxItems: 50, tweetLanguage: q.language }),
    ]);
    const r = runs[0].status === "fulfilled" ? runs[0].value : { runId: "-", datasetId: "-" };
    const x = runs[1].status === "fulfilled" ? runs[1].value : { runId: "-", datasetId: "-" };
    if (r.runId === "-" && x.runId === "-") return send(res, 502, { error: "apify_error" });
    return send(res, 200, { ticket: makeTicket([r.runId, r.datasetId, x.runId, x.datasetId, user.id]), queries: q });
  }

  if (req.method === "GET") {
    const url = new URL(req.url, "http://x");
    const t = readTicket(url.searchParams.get("ticket"), 5);
    if (!t || t[4] !== user.id) return send(res, 403, { error: "bad_ticket" });
    const [rRun, rData, xRun, xData] = t;
    const one = async (runId, dataId, map) => {
      if (runId === "-") return { done: true, posts: [] };
      try {
        const [run, items] = await Promise.all([apify(`/actor-runs/${runId}`), apify(`/datasets/${dataId}/items?clean=true&limit=60`)]);
        const status = (run.data && run.data.status) || "RUNNING";
        return { done: ["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(status), posts: (Array.isArray(items) ? items : []).map(map).filter(Boolean) };
      } catch { return { done: true, posts: [] }; }
    };
    const [a, b] = await Promise.all([one(rRun, rData, fromReddit), one(xRun, xData, fromX)]);
    const seen = new Set();
    const posts = [...a.posts, ...b.posts].filter(p => !seen.has(p.url) && seen.add(p.url));
    return send(res, 200, { done: a.done && b.done, posts });
  }

  return send(res, 405, { error: "method" });
}
