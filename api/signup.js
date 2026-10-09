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
  if (b.action === "reset") return resetPassword(req, res, key, clip(b.email, 200).toLowerCase());
  const email = clip(b.email, 200).toLowerCase(), password = String(b.password || "");
  const name = clip(b.name, 80);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send(res, 400, { error: "bad_email" });
  if (password.length < 6 || password.length > 200) return send(res, 400, { error: "bad_password" });

  const headers = { "Content-Type": "application/json", apikey: key };
  if (key.startsWith("eyJ")) headers.Authorization = "Bearer " + key; // legacy service_role JWT
  let r;
  try {
    r = await fetch(SUPABASE_URL.replace(/\/$/, "") + "/auth/v1/admin/users", {
      method: "POST", headers, signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { app: "shake-outreach", ...(name ? { name } : {}) } }),
    });
  } catch { return send(res, 502, { error: "upstream_error" }); }
  if (r.ok) return send(res, 200, { ok: true });
  const data = await r.json().catch(() => ({}));
  const msg = String(data.msg || data.message || data.error_description || "");
  if (r.status === 422 || /already/i.test(msg)) return send(res, 409, { error: "exists" });
  return send(res, 502, { error: "upstream_error" });
}

// Password reset sent by us (via Resend) from our own address, instead of Supabase's shared
// sender that lands in spam. The Supabase project is shared, so only our users get it.
// Always answers ok, so nobody can probe which emails have accounts.
const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
async function resetPassword(req, res, key, email) {
  if (!process.env.RESEND_API_KEY) return send(res, 501, { error: "not_configured" });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send(res, 400, { error: "bad_email" });
  const origin = "https://" + (req.headers["x-forwarded-host"] || req.headers.host);
  const headers = { "Content-Type": "application/json", apikey: key };
  if (key.startsWith("eyJ")) headers.Authorization = "Bearer " + key;
  try {
    const r = await fetch(SUPABASE_URL.replace(/\/$/, "") + "/auth/v1/admin/generate_link", {
      method: "POST", headers, signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ type: "recovery", email, redirect_to: origin }),
    });
    if (!r.ok) return send(res, 200, { ok: true });
    const d = await r.json();
    const link = d.action_link || (d.properties && d.properties.action_link);
    const user = d.user || d;
    if (!link || (user.user_metadata || {}).app !== "shake-outreach") return send(res, 200, { ok: true });
    const from = process.env.RESEND_FROM || "MyLeads <noreply@myleads.shakeapp.today>";
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#16151a;max-width:480px">
<p style="font-size:22px">🤝</p>
<p><b>Reset your password</b></p>
<p>Someone asked to reset the password for your MyLeads account (${esc(email)}). If it was you, use the button below. The link works once and expires soon.</p>
<p><a href="${esc(link)}" style="display:inline-block;background:#12935a;color:#ffffff;text-decoration:none;font-weight:bold;padding:11px 20px;border-radius:999px">Choose a new password</a></p>
<p style="color:#7a7782;font-size:13px">If you didn't ask for this, ignore this email; your password stays the same.</p>
<p style="color:#7a7782;font-size:13px">MyLeads by Shakeapp Inc. · contact@shakeapp.today</p></div>`;
    const text = `Reset your password\n\nSomeone asked to reset the password for your MyLeads account (${email}). If it was you, open this link (it works once):\n${link}\n\nIf you didn't ask for this, ignore this email.\n\nMyLeads by Shakeapp Inc. · contact@shakeapp.today`;
    await fetch("https://api.resend.com/emails", {
      method: "POST", signal: AbortSignal.timeout(8000),
      headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [email], reply_to: "contact@shakeapp.today", subject: "Reset your MyLeads password", html, text }),
    });
  } catch {}
  return send(res, 200, { ok: true });
}
