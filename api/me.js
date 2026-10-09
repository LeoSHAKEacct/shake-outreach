import { requireUser, send } from "./_claude.js";
import { account, isPaid, updateAppMeta } from "./_account.js";
import { stripe } from "./_stripe.js";

export default async function handler(req, res) {
  const user = await requireUser(req);
  if (!user || !user.id) return send(res, 401, { error: "auth_required" });
  const m = user.app_metadata || {};
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
