import crypto from "node:crypto";
import { SUPABASE_URL } from "./config.js";
import { send, readBody, clip } from "./_claude.js";
import { adminHeaders, isPaid, hotDaysLeft, updateAppMeta, unseal } from "./_account.js";
import { writeQueries, startHotRuns, collectRuns } from "./_hot_core.js";
import { scorePosts } from "./_hot_score.js";

// Weekly hot-leads email. People switch it on for one customer type and place;
// every Monday a cron job starts the Reddit/X searches, and a later one scores the
// posts and emails the best new ones from the user's own Gmail to themselves.
const BUDGET_MS = 50000;   // stay under the 60s function limit
const MAX_ITEMS = 10;

const eligible = user => isPaid(user) || (hotDaysLeft(user) || 0) > 0;
const hash = url => crypto.createHash("sha1").update(url).digest("base64url").slice(0, 12);

// Each user can have several weekly emails (one per customer type + place), by plan.
export const watchLimit = user => ({ pro: 3, growth: 2 })[String((user.app_metadata || {}).plan || "").toLowerCase()] || 1;
export function watchList(m) {
  if (Array.isArray(m.hot_watches)) return m.hot_watches.filter(w => w && w.on);
  return m.hot_watch && m.hot_watch.on ? [m.hot_watch] : [];   // older accounts had a single one
}
const watchKey = (segment, location) => (String(segment || "") + "|" + String(location || "")).toLowerCase();

// POST ?watch=1 {on, summary, segment, location, sender, site}
export async function setWatch(req, res, user) {
  if (req.method !== "POST") return send(res, 405, { error: "method" });
  const b = readBody(req);
  const m = user.app_metadata || {};
  const list = watchList(m);
  const segment = clip(b.segment, 120), location = clip(b.location, 80);
  const key = watchKey(segment, location);
  if (!b.on) {
    const next = list.filter(w => watchKey(w.segment, w.location) !== key);
    await updateAppMeta(user, { hot_watches: next, hot_watch: null });
    return send(res, 200, { on: false, watches: next.map(w => ({ segment: w.segment, location: w.location })) });
  }
  if (!eligible(user)) return send(res, 402, { error: "hot_trial_over" });
  const existing = list.find(w => watchKey(w.segment, w.location) === key);
  if (!existing && list.length >= watchLimit(user)) return send(res, 402, { error: "watch_limit", limit: watchLimit(user) });
  const summary = clip(b.summary, 400);
  if (!summary) return send(res, 400, { error: "no_query" });
  let q;
  try { q = await writeQueries(summary, segment, location); }
  catch (e) { return send(res, 502, { error: e.code || "upstream_error" }); }
  const w = {
    on: true, summary, segment, location, sender: clip(b.sender, 60), site: clip(b.site, 120), q,
    pending: null, seen: (existing && existing.seen) || [], last: (existing && existing.last) || null, since: Date.now(),
  };
  const next = [...list.filter(x => watchKey(x.segment, x.location) !== key), w];
  await updateAppMeta(user, { hot_watches: next, hot_watch: null });
  return send(res, 200, { on: true, segment, location, watches: next.map(x => ({ segment: x.segment, location: x.location })) });
}

function cronAllowed(req) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && req.headers.authorization === "Bearer " + secret;
}

// Everyone with the weekly email switched on. The Supabase project is shared, so filter hard.
async function watchers() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return [];
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const r = await fetch(SUPABASE_URL.replace(/\/$/, "") + "/auth/v1/admin/users?per_page=200&page=" + page, {
      headers: adminHeaders(key), signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) break;
    const d = await r.json();
    const users = d.users || [];
    out.push(...users.filter(u => u.app_metadata && watchList(u.app_metadata).length));
    if (users.length < 200) break;
  }
  return out;
}

async function inTurns(items, size, fn, started) {
  for (let i = 0; i < items.length; i += size) {
    if (Date.now() - started > BUDGET_MS) break;
    await Promise.allSettled(items.slice(i, i + size).map(fn));
  }
}

// Cron, Monday morning: start this week's searches, one per weekly email.
export async function digestStart(req, res) {
  if (!cronAllowed(req)) return send(res, 401, { error: "cron_only" });
  const started = Date.now();
  const list = await watchers();
  let count = 0;
  await inTurns(list, 4, async u => {
    const watches = watchList(u.app_metadata).slice(0, watchLimit(u));
    if (!eligible(u)) { await updateAppMeta(u, { hot_watches: [], hot_watch: null }); return; }
    const next = [];
    for (const w of watches) {
      if (w.pending) { next.push(w); continue; }
      const q = w.q || await writeQueries(w.summary, w.segment, w.location);
      const parts = await startHotRuns(q, "week");
      if (parts[0] === "-" && parts[2] === "-") { next.push({ ...w, q }); continue; }
      next.push({ ...w, q, pending: { parts, at: Date.now() } }); count++;
    }
    await updateAppMeta(u, { hot_watches: next, hot_watch: null });
  }, started);
  return send(res, 200, { started: count, users: list.length });
}

// Cron, later (runs daily): score finished searches and email the results.
export async function digestSend(req, res) {
  if (!cronAllowed(req)) return send(res, 401, { error: "cron_only" });
  const started = Date.now();
  const list = (await watchers()).filter(u => watchList(u.app_metadata).some(w => w.pending));
  let sent = 0;
  await inTurns(list, 3, async u => {
    const next = [];
    for (const w of watchList(u.app_metadata)) {
      if (!w.pending) { next.push(w); continue; }
      const { done, posts } = await collectRuns(w.pending.parts);
      if (!done && Date.now() - w.pending.at < 6 * 3600 * 1000) { next.push(w); continue; } // still running
      const seen = new Set(w.seen || []);
      const fresh = posts.filter(p => !seen.has(hash(p.url))).slice(0, 80);
      let items = [];
      if (fresh.length) {
        const matches = await scorePosts(w.summary, w.sender, fresh.map(p => p.text));
        items = matches.slice(0, MAX_ITEMS).map(m => ({ ...fresh[m.i], score: m.score, why: m.why, reply: m.reply }));
      }
      let delivered = false;
      const gmail = (u.app_metadata || {}).gmail;
      if (items.length && gmail && gmail.rt) delivered = await emailDigest(u, w, items).catch(() => false);
      if (delivered) sent++;
      next.push({ ...w, pending: null,
        seen: [...seen, ...items.map(p => hash(p.url))].slice(-400),
        last: { at: Date.now(), count: items.length, delivered, items: items.map(p => ({ source: p.source, url: p.url, text: p.text.slice(0, 280), why: p.why, reply: p.reply, score: p.score })) },
      });
    }
    await updateAppMeta(u, { hot_watches: next, hot_watch: null });
  }, started);
  return send(res, 200, { users: list.length, emailed: sent });
}

const esc = t => String(t || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const b64 = t => Buffer.from(t, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
const header = v => /^[\x20-\x7e]*$/.test(v) ? v : "=?UTF-8?B?" + Buffer.from(v, "utf8").toString("base64") + "?=";

async function emailDigest(user, w, items) {
  const m = user.app_metadata;
  const t = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: unseal(m.gmail.rt), grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(10000),
  }).then(r => r.json());
  if (!t.access_token) return false;

  const what = w.segment ? w.segment.toLowerCase() : "what you sell";
  const where = w.location ? " in " + w.location : "";
  const subject = "🔥 " + items.length + (items.length === 1 ? " person" : " people") + " asking for " + what + where + " this week";
  const text = items.map((p, i) => `${i + 1}. ${p.source} · ${p.score}% ready to buy\n${p.text}\nWhy: ${p.why}\nSuggested reply: ${p.reply}\n${p.url}`).join("\n\n")
    + "\n\nShake Outreach · weekly hot leads. Turn this email off on the site, under Hot leads.";
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#16151a;max-width:620px">
<p style="font-size:16px"><b>${esc(subject)}</b></p>
<p style="color:#7a7782">People posted this week asking for ${esc(what)}${esc(where)}. Reply while it's fresh: we wrote a reply for each.</p>
${items.map(p => `<div style="border:1px solid #e2ded6;border-radius:12px;padding:14px 16px;margin:12px 0">
<div style="font-size:12px;color:#7a7782">${esc(p.source)} · <b style="color:#12935a">${p.score}% ready to buy</b></div>
<p style="margin:8px 0">${esc(p.text)}</p>
<p style="margin:6px 0;color:#7a7782"><i>${esc(p.why)}</i></p>
<p style="margin:8px 0;background:#f5f3ef;border-radius:8px;padding:10px 12px">${esc(p.reply)}</p>
<a href="${esc(p.url)}" style="color:#12935a;font-weight:bold">Open the post →</a></div>`).join("")}
<p style="font-size:12px;color:#7a7782">Shake Outreach · weekly hot leads. Turn this email off on the site, under Hot leads.</p></div>`;
  const boundary = "so_" + Math.random().toString(36).slice(2);
  const raw = [
    "From: " + m.gmail.email, "To: " + m.gmail.email, "Subject: " + header(subject),
    "MIME-Version: 1.0", 'Content-Type: multipart/alternative; boundary="' + boundary + '"', "",
    "--" + boundary, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", b64(text),
    "--" + boundary, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", b64(html),
    "--" + boundary + "--", "",
  ].join("\r\n");
  const g = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST", headers: { Authorization: "Bearer " + t.access_token, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: Buffer.from(raw, "utf8").toString("base64url") }), signal: AbortSignal.timeout(10000),
  });
  return g.ok;
}
