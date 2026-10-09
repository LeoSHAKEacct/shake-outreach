import crypto from "node:crypto";
import { SUPABASE_URL } from "./config.js";

// Credits and connected Gmail live in the user's app_metadata, which only the
// server (with the Supabase secret key) can change.
export const START_CREDITS = 50;     // dollars of free credit for every new account
export const LEAD_PRICE = 0.10;      // charged per lead that comes with an email
export const DAILY_SEND_CAP = 50;    // emails per user per day, to protect their inbox

const KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY;
export const tracking = () => Boolean(KEY());
export const PAID_PLANS = ["starter", "growth", "pro"];
// Monthly price and the lead credit that comes with it (500 / 1,000 / 2,000 leads at LEAD_PRICE).
export const PLANS = {
  starter: { name: "Starter", price: 50, credits: 50 },
  growth: { name: "Growth", price: 88, credits: 100 },
  pro: { name: "Pro", price: 150, credits: 200 },
};
export const startCredits = user => {
  const m = (user && user.app_metadata) || {};
  return isPaid(user || {}) ? Number(m.plan_credits || PLANS[String(m.plan).toLowerCase()].credits) : START_CREDITS;
};
export const HOT_TRIAL_DAYS = 7;
export const TRIAL_DAYS = 15;          // the signup credit expires after this
// One-time top-ups: always priced above the plan rate per lead, so plans stay the better deal.
export const TOPUPS = {
  t17: { price: 17, leads: 140 },
  t35: { price: 35, leads: 300 },
  t70: { price: 70, leads: 650 },
};
const createdAt = user => Date.parse((user && user.created_at) || "") || Date.now();
export const trialEndsAt = user => Math.floor((createdAt(user) + TRIAL_DAYS * 86400000) / 1000);
export const trialExpired = user => !isPaid(user || {}) && Date.now() / 1000 > trialEndsAt(user);
export const topupLeft = user => Math.max(0, Number(((user && user.app_metadata) || {}).topup_balance || 0));
// Monthly (or trial) credit still unused; an expired trial has none.
export function baseLeft(user) {
  if (trialExpired(user)) return 0;
  const used = Number(((user && user.app_metadata) || {}).credits_used || 0);
  return Math.max(0, startCredits(user) - used);
}
// People who paid (a plan or a top-up) get the paid lead source.
export const paidSource = user => isPaid(user || {}) || topupLeft(user) > 0;
// What to store after spending `cost` dollars: plan/trial credit first, then top-up balance.
export function spendPatch(user, cost) {
  const m = (user && user.app_metadata) || {};
  const fromBase = Math.min(baseLeft(user), cost);
  return {
    credits_used: +(Number(m.credits_used || 0) + fromBase).toFixed(2),
    topup_balance: +Math.max(0, topupLeft(user) - (cost - fromBase)).toFixed(2),
  };
}
export const isPaid = user => PAID_PLANS.includes(String((user.app_metadata || {}).plan || "").toLowerCase());
export function hotDaysLeft(user) {
  if (isPaid(user)) return null;
  const start = Date.parse(user.created_at || "") || Date.now();
  return Math.max(0, Math.ceil(HOT_TRIAL_DAYS - (Date.now() - start) / 86400000));
}

export function account(user) {
  const m = (user && user.app_metadata) || {};
  const used = Number(m.credits_used || 0);
  const start = startCredits(user);
  return {
    credits_left: +(baseLeft(user) + topupLeft(user)).toFixed(2),
    topup_left: +topupLeft(user).toFixed(2),
    trial_ends_at: user && !isPaid(user) ? trialEndsAt(user) : null,
    trial_expired: user ? trialExpired(user) : false,
    topups: TOPUPS,
    credits_used: +used.toFixed(2),
    start_credits: start,
    leads_found: Number(m.leads_found || 0),
    emails_sent: Number(m.emails_sent || 0),
    lead_price: LEAD_PRICE,
    plan: m.plan || "trial",
    gmail: m.gmail ? m.gmail.email : "",
    billing: Boolean(m.stripe_customer || m.stripe_sub) || isPaid(user || {}),
    pending_plan: m.pending_plan || null,
    cancel_at: m.cancel_at || null,
    renews_at: m.renews_at || null,
    payments: Boolean(process.env.STRIPE_SECRET_KEY),
    paid: isPaid(user || {}),
    hot_days_left: user ? hotDaysLeft(user) : 0,
    hot_watches: (Array.isArray(m.hot_watches) ? m.hot_watches : (m.hot_watch ? [m.hot_watch] : [])).filter(w => w && w.on)
      .map(w => ({ segment: w.segment, location: w.location, last: w.last ? { at: w.last.at, count: w.last.count, delivered: w.last.delivered } : null })),
    hot_watch_limit: ({ pro: 3, growth: 2 })[String(m.plan || "").toLowerCase()] || 1,
    tracked: tracking(),
  };
}

export function adminHeaders(key) {
  const headers = { "Content-Type": "application/json", apikey: key };
  if (key.startsWith("eyJ")) headers.Authorization = "Bearer " + key;
  return headers;
}

export async function getUserById(id) {
  const key = KEY();
  if (!key) return null;
  const r = await fetch(SUPABASE_URL.replace(/\/$/, "") + "/auth/v1/admin/users/" + encodeURIComponent(id), {
    headers: adminHeaders(key), signal: AbortSignal.timeout(8000),
  });
  return r.ok ? r.json() : null;
}

export async function updateAppMeta(user, patch) {
  const key = KEY();
  if (!key) return null;
  const headers = adminHeaders(key);
  const r = await fetch(SUPABASE_URL.replace(/\/$/, "") + "/auth/v1/admin/users/" + user.id, {
    method: "PUT", headers, signal: AbortSignal.timeout(8000),
    body: JSON.stringify({ app_metadata: { ...(user.app_metadata || {}), ...patch } }),
  });
  if (!r.ok) throw { code: "account_update_failed" };
  return r.json();
}

// Encrypt secrets (the Gmail refresh token) before storing them on the user.
function aesKey() { return crypto.createHash("sha256").update(String(KEY()) + ":gmail").digest(); }
export function seal(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", aesKey(), iv);
  const enc = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString("base64url")).join(".");
}
export function unseal(blob) {
  const [iv, tag, enc] = String(blob).split(".").map(s => Buffer.from(s, "base64url"));
  const d = crypto.createDecipheriv("aes-256-gcm", aesKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}
export function signState(value) {
  const sig = crypto.createHmac("sha256", String(KEY())).update(value).digest("base64url");
  return value + "." + sig;
}
export function readState(state) {
  const i = String(state || "").lastIndexOf(".");
  if (i < 0) return null;
  const value = state.slice(0, i), sig = state.slice(i + 1);
  const good = crypto.createHmac("sha256", String(KEY())).update(value).digest("base64url");
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  return value;
}
