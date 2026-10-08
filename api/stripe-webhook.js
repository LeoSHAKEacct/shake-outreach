import { send } from "./_claude.js";
import { PLANS, getUserById, updateAppMeta } from "./_account.js";
import { stripe, verifyStripe } from "./_stripe.js";

// Stripe tells us when someone pays, renews or cancels; we set their plan and credits.
async function rawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  if (typeof req.body === "string") return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

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
    if (event.type === "checkout.session.completed" && o.mode === "subscription") {
      const key = (o.metadata || {}).plan;
      if (!PLANS[key]) return send(res, 200, { ok: true });
      await setPlan(o.client_reference_id || (o.metadata || {}).user_id, {
        plan: key, plan_credits: PLANS[key].credits, credits_used: 0,
        stripe_customer: o.customer, stripe_sub: o.subscription,
      });
    } else if (event.type === "invoice.paid" && o.billing_reason === "subscription_cycle") {
      // New month: fresh credits.
      // Newer Stripe API versions moved the subscription under invoice.parent.
      const details = (o.parent && o.parent.subscription_details) || {};
      const subId = o.subscription || details.subscription;
      const meta = details.metadata && details.metadata.user_id ? details.metadata : subId ? (await stripe("subscriptions/" + subId)).metadata : {};
      await setPlan((meta || {}).user_id, { credits_used: 0 });
    } else if (event.type === "customer.subscription.updated") {
      const key = (o.metadata || {}).plan;
      const active = o.status === "active" || o.status === "trialing";
      if (!active) await setPlan((o.metadata || {}).user_id, { plan: "trial", plan_credits: null });
      else if (PLANS[key]) await setPlan((o.metadata || {}).user_id, { plan: key, plan_credits: PLANS[key].credits });
    } else if (event.type === "customer.subscription.deleted") {
      await setPlan((o.metadata || {}).user_id, { plan: "trial", plan_credits: null, stripe_sub: null });
    }
  } catch {
    return send(res, 500, { error: "update_failed" }); // Stripe retries
  }
  return send(res, 200, { ok: true });
}
