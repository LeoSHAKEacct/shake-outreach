import { requireUser, send, readBody } from "./_claude.js";
import { PLANS } from "./_account.js";
import { stripe, origin } from "./_stripe.js";

// POST {plan} → a Stripe Checkout link for that monthly plan.
export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });
  const user = await requireUser(req);
  if (!user || !user.id) return send(res, 401, { error: "auth_required" });
  if (!process.env.STRIPE_SECRET_KEY) return send(res, 503, { error: "payments_off" });
  const key = String(readBody(req).plan || "").toLowerCase();
  const plan = PLANS[key];
  if (!plan) return send(res, 400, { error: "no_plan" });
  const m = user.app_metadata || {};
  const base = origin(req);
  try {
    const s = await stripe("checkout/sessions", {
      mode: "subscription",
      client_reference_id: user.id,
      ...(m.stripe_customer ? { customer: m.stripe_customer } : { customer_email: user.email }),
      line_items: { 0: { quantity: 1, price_data: {
        currency: "usd", unit_amount: plan.price * 100, recurring: { interval: "month" },
        product_data: { name: "Shake Outreach " + plan.name },
      } } },
      metadata: { user_id: user.id, plan: key },
      subscription_data: { metadata: { user_id: user.id, plan: key } },
      allow_promotion_codes: "true",
      success_url: base + "/?paid=" + key + "#billing",
      cancel_url: base + "/?paid=cancelled#billing",
    });
    return send(res, 200, { url: s.url });
  } catch (e) {
    return send(res, 502, { error: e.code || "stripe_error" });
  }
}
