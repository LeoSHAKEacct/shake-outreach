import crypto from "node:crypto";

// Minimal Stripe client over fetch: form-encoded requests, JSON responses.
function form(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") form(v, key, out);
    else out.push(encodeURIComponent(key) + "=" + encodeURIComponent(v));
  }
  return out.join("&");
}

export async function stripe(path, params) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw { code: "payments_off" };
  const r = await fetch("https://api.stripe.com/v1/" + path, {
    method: params ? "POST" : "GET",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/x-www-form-urlencoded" },
    body: params ? form(params) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw { code: "stripe_error", message: data.error && data.error.message };
  return data;
}

// Checks the Stripe-Signature header against the raw request body.
export function verifyStripe(raw, header, secret, toleranceSec = 300) {
  const parts = Object.fromEntries(String(header || "").split(",").map(p => p.split("=")).filter(p => p.length === 2 && p[0] !== "v1"));
  const sigs = String(header || "").split(",").filter(p => p.startsWith("v1=")).map(p => p.slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const good = crypto.createHmac("sha256", secret).update(t + "." + raw).digest("hex");
  return sigs.some(s => s.length === good.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good)));
}

export const origin = req => "https://" + (req.headers["x-forwarded-host"] || req.headers.host);
