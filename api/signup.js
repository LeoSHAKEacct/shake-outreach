import { SUPABASE_URL } from "./config.js";
import { rateLimited, send, readBody, clip } from "./_claude.js";

// Creates an already-confirmed account so sign-up works without a confirmation email.
// Needs SUPABASE_SERVICE_ROLE_KEY (secret key) in Vercel; without it the page falls back
// to Supabase's normal email sign-up.
export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "method" });
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return send(res, 501, { error: "not_configured" });
  if (rateLimited(req, null, 5)) return send(res, 429, { error: "rate_limited" });

  const b = readBody(req);
  const email = clip(b.email, 200).toLowerCase(), password = String(b.password || "");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send(res, 400, { error: "bad_email" });
  if (password.length < 6 || password.length > 200) return send(res, 400, { error: "bad_password" });

  const headers = { "Content-Type": "application/json", apikey: key };
  if (key.startsWith("eyJ")) headers.Authorization = "Bearer " + key; // legacy service_role JWT
  let r;
  try {
    r = await fetch(SUPABASE_URL.replace(/\/$/, "") + "/auth/v1/admin/users", {
      method: "POST", headers, signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { app: "shake-outreach" } }),
    });
  } catch { return send(res, 502, { error: "upstream_error" }); }
  if (r.ok) return send(res, 200, { ok: true });
  const data = await r.json().catch(() => ({}));
  const msg = String(data.msg || data.message || data.error_description || "");
  if (r.status === 422 || /already/i.test(msg)) return send(res, 409, { error: "exists" });
  return send(res, 502, { error: "upstream_error" });
}
