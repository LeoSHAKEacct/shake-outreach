import { askJSON } from "./_claude.js";
import { apify, startRun } from "./_apify.js";

// Shared hot-leads pieces, used by the live search (hot.js) and the weekly email (_digest.js).
const REDDIT = "trudax~reddit-scraper-lite";
const X = "apidojo~tweet-scraper";
const GOOGLE = "apify~google-search-scraper";
// Owner-only deep scan also reads public posts on these sites through Google search results
// (no logging in to any of them).
const SITES = ["facebook.com", "instagram.com", "nextdoor.com", "craigslist.org", "quora.com", "tiktok.com"];
const SITE_NAMES = { "facebook.com": "Facebook", "instagram.com": "Instagram", "nextdoor.com": "Nextdoor", "craigslist.org": "Craigslist", "quora.com": "Quora", "tiktok.com": "TikTok" };

const QUERIES = {
  type: "object", additionalProperties: false, required: ["language", "reddit", "x", "web"],
  properties: {
    language: { type: "string" },
    reddit: { type: "array", items: { type: "string" } },
    x: { type: "array", items: { type: "string" } },
    web: { type: "array", items: { type: "string" } },
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


export function fromGoogle(page) {
  return (page.organicResults || []).map(r => {
    let host = "";
    try { host = new URL(r.url).hostname.replace(/^(www|m|[a-z]{2})\./, ""); } catch {}
    const site = SITES.find(s => host === s || host.endsWith("." + s));
    const text = [r.title, r.description].filter(Boolean).join("\n").trim();
    if (!site || !text) return null;
    return { source: SITE_NAMES[site], text: text.slice(0, 600), url: r.url, author: "", where: "", at: r.date || "" };
  }).filter(Boolean);
}

export async function writeQueries(summary, segment, location, deep = false) {
  return askJSON(`A business wants to find people who are asking online, right now, for what it sells.

Business: ${summary}
Customer type to focus on: ${segment || "any"}
Place: ${location || "anywhere"}

Write short search queries that would find posts where someone is actively looking to buy, rent, hire or book this kind of product or service: "looking for", "need", "ISO", "any recommendations", "moving to", "where can I find", or complaining about their current provider. Use the words and the language people in that place actually post in.
- language: ISO 639-1 code of that language.
- reddit: ${deep ? 6 : 3} plain search phrases (3-6 words each). Include the place when it helps.
- x: ${deep ? 4 : 2} X/Twitter search queries (3-6 words each, you may use OR), add " -filter:retweets" at the end.
- web: ${deep ? 4 : 0} Google phrases (3-7 words, with the place) that match how people word these requests in Facebook groups, Instagram, Nextdoor or Craigslist "wanted" posts. Use quotes around the key phrase.`, QUERIES, "low");
}

// Starts the searches; returns [redditRun, redditData, xRun, xData] plus, for a deep scan,
// [googleRun, googleData] ("-" when one failed). Deep scans (owner only) read about 4x more.
export async function startHotRuns(q, time = "month", deep = false) {
  const site = "(" + SITES.map(s => "site:" + s).join(" OR ") + ")";
  const runs = await Promise.allSettled([
    startRun(REDDIT, { searches: q.reddit.slice(0, deep ? 6 : 3), searchPosts: true, searchComments: false, searchCommunities: false, searchUsers: false,
      sort: "new", time, maxItems: deep ? 150 : 40, skipComments: true, includeNSFW: false }),
    startRun(X, { searchTerms: q.x.slice(0, deep ? 4 : 2), sort: "Latest", maxItems: deep ? 200 : 50, tweetLanguage: q.language }),
    deep && (q.web || []).length
      ? startRun(GOOGLE, { queries: q.web.slice(0, 4).map(w => w + " " + site).join("\n"), maxPagesPerQuery: 2,
          quickDateRange: time === "week" ? "w1" : "m1", saveHtmlToKeyValueStore: false })
      : Promise.reject(new Error("off")),
  ]);
  const ids = r => r.status === "fulfilled" ? [r.value.runId, r.value.datasetId] : ["-", "-"];
  return [...ids(runs[0]), ...ids(runs[1]), ...(deep ? ids(runs[2]) : [])];
}

export async function collectRuns([rRun, rData, xRun, xData, gRun = "-", gData = "-"]) {
  const one = async (runId, dataId, map, limit = 200) => {
    if (runId === "-") return { done: true, posts: [], status: "NOT_STARTED" };
    try {
      const [run, items] = await Promise.all([apify(`/actor-runs/${runId}`), apify(`/datasets/${dataId}/items?clean=true&limit=${limit}`)]);
      const status = (run.data && run.data.status) || "RUNNING";
      return { done: ["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(status), status, posts: (Array.isArray(items) ? items : []).flatMap(i => map(i) || []).filter(Boolean) };
    } catch { return { done: true, posts: [], status: "ERROR" }; }
  };
  const [a, b, g] = await Promise.all([one(rRun, rData, fromReddit), one(xRun, xData, fromX), one(gRun, gData, fromGoogle, 20)]);
  const seen = new Set();
  const sources = { Reddit: { status: a.status, count: a.posts.length }, X: { status: b.status, count: b.posts.length } };
  if (gRun !== "-") sources.Web = { status: g.status, count: g.posts.length };
  return {
    done: a.done && b.done && g.done,
    posts: [...g.posts, ...a.posts, ...b.posts].filter(p => !seen.has(p.url) && seen.add(p.url)),
    // What each source did, so the page can say "read 40 posts, none were buyers" vs "couldn't reach X".
    sources,
  };
}
