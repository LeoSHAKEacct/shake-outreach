import { askJSON } from "./_claude.js";
import { apify, startRun } from "./_apify.js";

// Shared hot-leads pieces, used by the live search (hot.js) and the weekly email (_digest.js).
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

export function fromReddit(p) {
  if (p.dataType && p.dataType !== "post") return null;
  const text = [p.title, p.body].filter(Boolean).join("\n").trim();
  if (!text || !p.url) return null;
  return { source: "Reddit", text: text.slice(0, 600), url: p.url, author: p.username || "", where: p.communityName || "", at: p.createdAt || "" };
}
export function fromX(t) {
  if (!t.text || !t.url || t.isRetweet) return null;
  return { source: "X", text: String(t.text).slice(0, 600), url: t.url, author: (t.author && t.author.userName) || "", where: "", at: t.createdAt || "" };
}


export async function writeQueries(summary, segment, location) {
  return askJSON(`A business wants to find people who are asking online, right now, for what it sells.

Business: ${summary}
Customer type to focus on: ${segment || "any"}
Place: ${location || "anywhere"}

Write short search queries that would find posts where someone is actively looking for this kind of product or service: asking for recommendations, complaining about their current provider, or saying they need it. Use the language people in that place actually post in.
- language: ISO 639-1 code of that language.
- reddit: 3 plain search phrases (3-6 words each).
- x: 2 X/Twitter search queries (3-6 words each, you may use OR), add " -filter:retweets" at the end.`, QUERIES, "low");
}

// Starts the Reddit and X searches; returns [redditRun, redditData, xRun, xData] ("-" when one failed).
export async function startHotRuns(q, time = "month") {
  const runs = await Promise.allSettled([
    startRun(REDDIT, { searches: q.reddit.slice(0, 3), searchPosts: true, searchComments: false, searchCommunities: false, searchUsers: false,
      sort: "new", time, maxItems: 40, skipComments: true, includeNSFW: false }),
    startRun(X, { searchTerms: q.x.slice(0, 2), sort: "Latest", maxItems: 50, tweetLanguage: q.language }),
  ]);
  const r = runs[0].status === "fulfilled" ? runs[0].value : { runId: "-", datasetId: "-" };
  const x = runs[1].status === "fulfilled" ? runs[1].value : { runId: "-", datasetId: "-" };
  return [r.runId, r.datasetId, x.runId, x.datasetId];
}

export async function collectRuns([rRun, rData, xRun, xData]) {
  const one = async (runId, dataId, map) => {
    if (runId === "-") return { done: true, posts: [], status: "NOT_STARTED" };
    try {
      const [run, items] = await Promise.all([apify(`/actor-runs/${runId}`), apify(`/datasets/${dataId}/items?clean=true&limit=60`)]);
      const status = (run.data && run.data.status) || "RUNNING";
      return { done: ["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(status), status, posts: (Array.isArray(items) ? items : []).map(map).filter(Boolean) };
    } catch { return { done: true, posts: [], status: "ERROR" }; }
  };
  const [a, b] = await Promise.all([one(rRun, rData, fromReddit), one(xRun, xData, fromX)]);
  const seen = new Set();
  return {
    done: a.done && b.done,
    posts: [...a.posts, ...b.posts].filter(p => !seen.has(p.url) && seen.add(p.url)),
    // What each source did, so the page can say "read 40 posts, none were buyers" vs "couldn't reach X".
    sources: { Reddit: { status: a.status, count: a.posts.length }, X: { status: b.status, count: b.posts.length } },
  };
}
