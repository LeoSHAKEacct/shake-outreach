import { requireUser, send, readBody } from "./_claude.js";
import { PLANS, TOPUPS, updateAppMeta } from "./_account.js";
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
const LIVE = ["active", "trialing", "past_due"];
// The user's live subscription. Tries, in order: the id we stored, the stored customer,
// a search by our user id, then any Stripe customer with the user's email.
// `trail` records what each step found, so a miss can be explained.
async function findSub(user, trail = []) {
  const m = user.app_metadata || {};
  const pick = list => (list || []).find(s => LIVE.includes(s.status));
  const save = async s => { await updateAppMeta(user, { stripe_sub: s.id, stripe_customer: s.customer }).catch(() => {}); return s; };
  if (m.stripe_sub) {
    try {
      const s = await stripe("subscriptions/" + m.stripe_sub);
      trail.push("stored sub " + s.status);
      if (LIVE.includes(s.status)) return s;
    } catch (e) { trail.push("stored sub error"); }
  } else trail.push("no stored sub");
  if (m.stripe_customer) {
    try {
      const r = await stripe("subscriptions?status=all&limit=10&customer=" + encodeURIComponent(m.stripe_customer));
      trail.push("stored customer subs " + (r.data || []).length);
      const s = pick(r.data); if (s) return save(s);
    } catch { trail.push("stored customer error"); }
  } else trail.push("no stored customer");
  try {
    const q = encodeURIComponent(`metadata['user_id']:'${user.id}'`);
    const r = await stripe("subscriptions/search?query=" + q);
    trail.push("search " + (r.data || []).length);
    const s = pick(r.data); if (s) return save(s);
  } catch { trail.push("search error"); }
  if (user.email) {
    try {
      const c = await stripe("customers?limit=10&email=" + encodeURIComponent(user.email));
      trail.push("email customers " + (c.data || []).length);
      for (const cu of c.data || []) {
        const r = await stripe("subscriptions?status=all&limit=10&customer=" + encodeURIComponent(cu.id));
        const s = pick(r.data); if (s) return save(s);
      }
    } catch { trail.push("email lookup error"); }
  }
  return null;
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
  const trail = [];
  const sub = await findSub(user, trail);
  if (!sub) return send(res, 400, { error: "no_billing", message: "no active subscription found (" + trail.join(", ") + ")" });
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
  const trail = [];
  const sub = await findSub(user, trail);
  if (!sub) return send(res, 400, { error: "no_billing", message: "no active subscription found (" + trail.join(", ") + ")" });
  const s = await stripe("subscriptions/" + sub.id, { cancel_at_period_end: undo ? "false" : "true" });
  const end = periodEnd(s);
  await updateAppMeta(user, { cancel_at: undo ? null : end, renews_at: end });
  return send(res, 200, { done: undo ? "resumed" : "cancelled", at: end });
}

// One-time top-up: a Stripe Checkout payment; the webhook adds the leads.
async function topup(req, res, user, key) {
  const t = TOPUPS[key];
  if (!t) return send(res, 400, { error: "no_topup" });
  const m = user.app_metadata || {};
  const base = origin(req);
  const s = await stripe("checkout/sessions", {
    mode: "payment",
    client_reference_id: user.id,
    ...(m.stripe_customer ? { customer: m.stripe_customer } : { customer_email: user.email, customer_creation: "always" }),
    line_items: { 0: { quantity: 1, price_data: {
      currency: "usd", unit_amount: t.price * 100,
      product_data: { name: "Shake Outreach top-up · " + t.leads + " leads" },
    } } },
    metadata: { user_id: user.id, topup: key },
    success_url: base + "/?topup=" + key + "#billing",
    cancel_url: base + "/?paid=cancelled#billing",
  });
  return send(res, 200, { url: s.url });
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
  // The action comes from the rewrite (?do=), the body, or the path itself (/api/billing/<action>).
  const body = readBody(req);
  const fromPath = (String(req.url || "").split("?")[0].match(/\/api\/billing\/([a-z]+)/) || [])[1];
  const action = (req.query && req.query.do) || body.action || fromPath || "";
  const key = String(body.plan || "").toLowerCase();
  try {
    if (action === "checkout") return await checkout(req, res, user, key);
    if (action === "change") return await change(res, user, key);
    if (action === "cancel") return await cancel(res, user, false);
    if (action === "resume") return await cancel(res, user, true);
    if (action === "portal") return await portal(req, res, user);
    if (action === "topup") return await topup(req, res, user, String(body.pack || ""));
    return send(res, 400, { error: "no_action" });
  } catch (e) {
    console.error("billing", action, e);
    return send(res, 502, { error: e.code || "stripe_error", message: e.message || "" });
  }
}
