import { requireUser, send, readBody } from "./_claude.js";
import { PLANS, updateAppMeta } from "./_account.js";
import { stripe, origin } from "./_stripe.js";

// Everything plan-related, behind one function (Vercel's function limit):
//   do=checkout {plan}  → Stripe Checkout link, only for someone without a subscription
//   do=change   {plan}  → upgrade now (charged the difference) or downgrade at the next renewal
//   do=cancel / resume  → cancel at the end of the paid month, or undo that
//   do=portal           → Stripe page for card and invoices
const RANK = { trial: 0, starter: 1, growth: 2, pro: 3 };

// One Stripe price per plan, created on first use and found again by lookup key.
async function planPrice(key) {
  const found = await stripe("prices?active=true&lookup_keys%5B%5D=so_" + key + "_monthly");
  if (found.data && found.data[0]) return found.data[0].id;
  const p = await stripe("prices", {
    currency: "usd", unit_amount: PLANS[key].price * 100, recurring: { interval: "month" },
    lookup_key: "so_" + key + "_monthly", product_data: { name: "Shake Outreach " + PLANS[key].name },
  });
  return p.id;
}

// The user's live subscription: the one we stored, else a search by user id.
async function findSub(user) {
  const m = user.app_metadata || {};
  if (m.stripe_sub) {
    try {
      const s = await stripe("subscriptions/" + m.stripe_sub);
      if (s.status !== "canceled") return s;
    } catch {}
  }
  const q = encodeURIComponent(`metadata['user_id']:'${user.id}' AND status:'active'`);
  const r = await stripe("subscriptions/search?query=" + q);
  const s = r.data && r.data[0];
  if (s) await updateAppMeta(user, { stripe_sub: s.id, stripe_customer: s.customer });
  return s || null;
}

const periodEnd = s => s.current_period_end || (s.items && s.items.data[0] && s.items.data[0].current_period_end) || null;

async function checkout(req, res, user, key) {
  if (!PLANS[key]) return send(res, 400, { error: "no_plan" });
  if (await findSub(user)) return send(res, 409, { error: "has_plan" });
  const m = user.app_metadata || {};
  const base = origin(req);
  const s = await stripe("checkout/sessions", {
    mode: "subscription",
    client_reference_id: user.id,
    ...(m.stripe_customer ? { customer: m.stripe_customer } : { customer_email: user.email }),
    line_items: { 0: { quantity: 1, price: await planPrice(key) } },
    metadata: { user_id: user.id, plan: key },
    subscription_data: { metadata: { user_id: user.id, plan: key } },
    allow_promotion_codes: "true",
    success_url: base + "/?paid=" + key + "#billing",
    cancel_url: base + "/?paid=cancelled#billing",
  });
  return send(res, 200, { url: s.url });
}

async function change(res, user, key) {
  if (!PLANS[key]) return send(res, 400, { error: "no_plan" });
  const sub = await findSub(user);
  if (!sub) return send(res, 400, { error: "no_billing" });
  const m = user.app_metadata || {};
  const now = String(m.plan || "trial").toLowerCase();
  const item = sub.items.data[0].id;
  const price = await planPrice(key);
  const meta = { user_id: user.id, plan: key };
  const renews = periodEnd(sub);

  if (RANK[key] > RANK[now]) {
    // Upgrade: charge the prorated difference today and give the bigger credit right away.
    await stripe("subscriptions/" + sub.id, {
      items: { 0: { id: item, price } }, metadata: meta, cancel_at_period_end: "false",
      proration_behavior: "always_invoice", payment_behavior: "error_if_incomplete",
    });
    await updateAppMeta(user, { plan: key, plan_credits: PLANS[key].credits, pending_plan: null, cancel_at: null, renews_at: renews, stripe_sub: sub.id, stripe_customer: sub.customer });
    return send(res, 200, { done: "upgraded", plan: key });
  }
  if (key === now) {
    // Picking your own plan again undoes a pending downgrade.
    await stripe("subscriptions/" + sub.id, { items: { 0: { id: item, price } }, metadata: meta, proration_behavior: "none", cancel_at_period_end: "false" });
    await updateAppMeta(user, { pending_plan: null, cancel_at: null, renews_at: renews });
    return send(res, 200, { done: "kept", plan: key });
  }
  // Downgrade: nothing to pay. This month stays as it is; the next renewal bills the smaller plan.
  await stripe("subscriptions/" + sub.id, { items: { 0: { id: item, price } }, metadata: meta, proration_behavior: "none", cancel_at_period_end: "false" });
  await updateAppMeta(user, { pending_plan: key, cancel_at: null, renews_at: renews });
  return send(res, 200, { done: "downgraded", plan: key, at: renews });
}

async function cancel(res, user, undo) {
  const sub = await findSub(user);
  if (!sub) return send(res, 400, { error: "no_billing" });
  const s = await stripe("subscriptions/" + sub.id, { cancel_at_period_end: undo ? "false" : "true" });
  const end = periodEnd(s);
  await updateAppMeta(user, { cancel_at: undo ? null : end, renews_at: end });
  return send(res, 200, { done: undo ? "resumed" : "cancelled", at: end });
}

async function portal(req, res, user) {
  let customer = (user.app_metadata || {}).stripe_customer;
  if (!customer) { const sub = await findSub(user); customer = sub && sub.customer; }
  if (!customer) return send(res, 400, { error: "no_billing" });
  const s = await stripe("billing_portal/sessions", { customer, return_url: origin(req) + "/#billing" });
  return send(res, 200, { url: s.url });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });
  const user = await requireUser(req);
  if (!user || !user.id) return send(res, 401, { error: "auth_required" });
  if (!process.env.STRIPE_SECRET_KEY) return send(res, 503, { error: "payments_off" });
  const action = (req.query && req.query.do) || "";
  const key = String(readBody(req).plan || "").toLowerCase();
  try {
    if (action === "checkout") return await checkout(req, res, user, key);
    if (action === "change") return await change(res, user, key);
    if (action === "cancel") return await cancel(res, user, false);
    if (action === "resume") return await cancel(res, user, true);
    if (action === "portal") return await portal(req, res, user);
    return send(res, 400, { error: "no_action" });
  } catch (e) {
    return send(res, 502, { error: e.code || "stripe_error", message: e.message || "" });
  }
}
