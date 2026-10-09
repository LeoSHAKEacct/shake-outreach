import { send } from "./_claude.js";
import { PLANS, TOPUPS, LEAD_PRICE, getUserById, updateAppMeta } from "./_account.js";
import { stripe, verifyStripe } from "./_stripe.js";

// Stripe tells us when someone pays, renews or cancels; we set their plan and credits.
async function rawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  if (typeof req.body === "string") return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

const periodEnd = s => s.current_period_end || (s.items && s.items.data[0] && s.items.data[0].current_period_end) || null;

async function setPlan(userId, patch) {
  const user = userId && await getUserById(userId);
  if (!user) return;
  await updateAppMeta(user, patch);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return send(res, 503, { error: "payments_off" });
  const raw = await rawBody(req);
  if (!verifyStripe(raw, req.headers["stripe-signature"], secret)) return send(res, 400, { error: "bad_signature" });
  const event = JSON.parse(raw);
  const o = event.data.object;
  try {
    if (event.type === "checkout.session.completed" && o.mode === "payment" && TOPUPS[(o.metadata || {}).topup]) {
      // Top-up paid: add its leads to the balance once per checkout session.
      if (o.payment_status !== "paid") return send(res, 200, { ok: true });
      const user = await getUserById(o.client_reference_id || o.metadata.user_id);
      if (!user) return send(res, 200, { ok: true });
      const m = user.app_metadata || {};
      const done = m.topup_sessions || [];
      if (!done.includes(o.id)) {
        await updateAppMeta(user, {
          topup_balance: +(Number(m.topup_balance || 0) + TOPUPS[o.metadata.topup].leads * LEAD_PRICE).toFixed(2),
          topup_sessions: [...done, o.id].slice(-30),
          ...(o.customer && !m.stripe_customer ? { stripe_customer: o.customer } : {}),
        });
      }
    } else if (event.type === "checkout.session.completed" && o.mode === "subscription") {
      const key = (o.metadata || {}).plan;
      if (!PLANS[key]) return send(res, 200, { ok: true });
      let renews = null;
      try { renews = periodEnd(await stripe("subscriptions/" + o.subscription)); } catch {}
      await setPlan(o.client_reference_id || (o.metadata || {}).user_id, {
        plan: key, plan_credits: PLANS[key].credits, credits_used: 0, pending_plan: null, cancel_at: null,
        stripe_customer: o.customer, stripe_sub: o.subscription, renews_at: renews,
      });
    } else if (event.type === "invoice.paid" && o.billing_reason === "subscription_cycle") {
      // New month: the plan on the subscription now (a downgrade lands here) and fresh credits.
      const details = (o.parent && o.parent.subscription_details) || {};
      const sub = await stripe("subscriptions/" + (o.subscription || details.subscription));
      const meta = sub.metadata || {};
      const end = sub.current_period_end || (sub.items && sub.items.data[0] && sub.items.data[0].current_period_end) || null;
      const patch = { credits_used: 0, pending_plan: null, renews_at: end };
      if (PLANS[meta.plan]) Object.assign(patch, { plan: meta.plan, plan_credits: PLANS[meta.plan].credits });
      await setPlan(meta.user_id, patch);
    } else if (event.type === "customer.subscription.updated") {
      // Plan changes are applied by /api/billing; here we only catch failed or unpaid subscriptions.
      if (!["active", "trialing", "past_due"].includes(o.status)) {
        await setPlan((o.metadata || {}).user_id, { plan: "trial", plan_credits: null, pending_plan: null, cancel_at: null });
      }
    } else if (event.type === "customer.subscription.deleted") {
      await setPlan((o.metadata || {}).user_id, { plan: "trial", plan_credits: null, stripe_sub: null, pending_plan: null, cancel_at: null, renews_at: null });
    }
  } catch {
    return send(res, 500, { error: "update_failed" }); // Stripe retries
  }
  return send(res, 200, { ok: true });
}
