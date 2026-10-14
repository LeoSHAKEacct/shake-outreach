import { SUPABASE_URL } from "./config.js";
import { adminHeaders, isPaid } from "./_account.js";

// Owner-only numbers. The Supabase project is shared with another app, so only count
// people who signed up here or have used Shake Outreach.
const OURS = ["so_seen", "leads_found", "credits_used", "charged_runs", "hot_watches", "hot_watch", "gmail", "emails_sent", "topup_balance"];
const isOurs = u => (u.user_metadata || {}).app === "shake-outreach" || OURS.some(k => (u.app_metadata || {})[k] != null);

export async function stats() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return null;
  const all = [];
  for (let page = 1; page <= 50; page++) {
    const r = await fetch(SUPABASE_URL.replace(/\/$/, "") + "/auth/v1/admin/users?per_page=200&page=" + page, {
      headers: adminHeaders(key), signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) break;
    const users = (await r.json()).users || [];
    all.push(...users.filter(isOurs));
    if (users.length < 200) break;
  }
  const now = Date.now(), day = 86400000;
  const since = (u, f, d) => (now - (Date.parse(u[f] || "") || 0)) < d;
  const plans = {};
  for (const u of all) if (isPaid(u)) { const p = String(u.app_metadata.plan).toLowerCase(); plans[p] = (plans[p] || 0) + 1; }
  const sum = k => all.reduce((n, u) => n + Number((u.app_metadata || {})[k] || 0), 0);
  return {
    users: all.length,
    signups: { today: all.filter(u => since(u, "created_at", day)).length, week: all.filter(u => since(u, "created_at", 7 * day)).length, month: all.filter(u => since(u, "created_at", 30 * day)).length },
    active_week: all.filter(u => since(u, "last_sign_in_at", 7 * day)).length,
    paid: Object.values(plans).reduce((a, b) => a + b, 0), plans,
    gmail_connected: all.filter(u => (u.app_metadata || {}).gmail).length,
    leads_found: sum("leads_found"), emails_sent: sum("emails_sent"),
    recent: all.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, 25).map(u => ({
      email: u.email, at: u.created_at, last: u.last_sign_in_at || null,
      plan: isPaid(u) ? String(u.app_metadata.plan).toLowerCase() : "trial",
      leads: Number((u.app_metadata || {}).leads_found || 0), via: ((u.app_metadata || {}).provider || "email"),
    })),
  };
}
