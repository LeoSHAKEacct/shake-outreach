import { requireUser, send } from "./_claude.js";
import { account, isPaid, isOwner, updateAppMeta } from "./_account.js";
import { stats } from "./_stats.js";
import { stripe } from "./_stripe.js";

export default async function handler(req, res) {
  let user = await requireUser(req);
  if (!user || !user.id) return send(res, 401, { error: "auth_required" });
  // Owner only: users and signups (?stats=1).
  if (/[?&]stats=1/.test(req.url || "")) {
    if (!isOwner(user)) return send(res, 403, { error: "owner_only" });
    const s = await stats();
    return s ? send(res, 200, s) : send(res, 503, { error: "no_admin_key" });
  }
  let m = user.app_metadata || {};
  // Mark everyone who opens Shake Outreach (Google sign-ins aren't tagged at signup), so stats can count them.
  if (!m.so_seen) {
    const updated = await updateAppMeta(user, { so_seen: Date.now() }).catch(() => null);
    if (updated) { user = updated; m = user.app_metadata || {}; }
  }
  // Older paid accounts have no renewal date stored yet: read it from Stripe once.
  if (isPaid(user) && m.stripe_sub && !m.renews_at && process.env.STRIPE_SECRET_KEY) {
    try {
      const s = await stripe("subscriptions/" + m.stripe_sub);
      const end = s.current_period_end || (s.items && s.items.data[0] && s.items.data[0].current_period_end);
      if (end) {
        const updated = await updateAppMeta(user, { renews_at: end });
        return send(res, 200, account(updated || { ...user, app_metadata: { ...m, renews_at: end } }));
      }
    } catch {}
  }
  send(res, 200, account(user));
}
