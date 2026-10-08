import { requireUser, send } from "./_claude.js";
import { stripe, origin } from "./_stripe.js";

// POST → a Stripe customer portal link to change card, switch plan or cancel.
export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });
  const user = await requireUser(req);
  if (!user || !user.id) return send(res, 401, { error: "auth_required" });
  const customer = (user.app_metadata || {}).stripe_customer;
  if (!customer) return send(res, 400, { error: "no_billing" });
  try {
    const s = await stripe("billing_portal/sessions", { customer, return_url: origin(req) + "/#billing" });
    return send(res, 200, { url: s.url });
  } catch (e) {
    return send(res, 502, { error: e.code || "stripe_error" });
  }
}
