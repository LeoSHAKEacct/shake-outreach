import { requireUser, send, readBody, clip } from "./_claude.js";
import { unseal, updateAppMeta, DAILY_SEND_CAP } from "./_account.js";

// Sends one personal email per recipient from the user's connected Gmail.
function header(v) { return /^[\x20-\x7e]*$/.test(v) ? v : "=?UTF-8?B?" + Buffer.from(v, "utf8").toString("base64") + "?="; }
function mime({ from, to, subject, body }) {
  return [
    "From: " + from, "To: " + to, "Subject: " + header(subject),
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64",
    "", Buffer.from(body, "utf8").toString("base64"),
  ].join("\r\n");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "method" });
  const user = await requireUser(req);
  if (!user || !user.id) return send(res, 401, { error: "auth_required" });
  const m = user.app_metadata || {};
  if (!m.gmail || !m.gmail.rt) return send(res, 409, { error: "gmail_not_connected" });

  const b = readBody(req);
  const subject = clip(b.subject, 200), template = String(b.body || "").slice(0, 5000);
  const list = (Array.isArray(b.recipients) ? b.recipients : [])
    .map(r => ({ email: clip(r && r.email, 200).toLowerCase(), name: clip(r && r.name, 120) }))
    .filter(r => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email));
  const unique = [...new Map(list.map(r => [r.email, r])).values()];
  if (!unique.length || !subject || !template.trim()) return send(res, 400, { error: "nothing_to_send" });
  // Anti-spam law (CAN-SPAM) wants the sender's postal address in every commercial email.
  const address = clip((user.user_metadata || {}).address, 200);
  if (!address) return send(res, 400, { error: "needs_address" });

  const today = new Date().toISOString().slice(0, 10);
  const sentToday = m.sent_day === today ? Number(m.sent_today || 0) : 0;
  const room = DAILY_SEND_CAP - sentToday;
  if (room <= 0) return send(res, 429, { error: "daily_cap", cap: DAILY_SEND_CAP });
  const batch = unique.slice(0, room);

  let access;
  try {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token: unseal(m.gmail.rt), grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(10000),
    });
    const t = await r.json();
    if (!r.ok || !t.access_token) throw 0;
    access = t.access_token;
  } catch {
    return send(res, 409, { error: "gmail_not_connected" });
  }

  const sent = [], failed = [];
  for (const r of batch) {
    const body = template.split("[Business]").join(r.name || "there").split("[First name]").join(r.name ? r.name + " team" : "there")
      + "\n\n--\n" + address + "\nIf this isn't relevant, just reply \"no thanks\" and I won't write again.";
    const raw = Buffer.from(mime({ from: m.gmail.email, to: r.email, subject, body }), "utf8").toString("base64url");
    try {
      const g = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST", headers: { Authorization: "Bearer " + access, "Content-Type": "application/json" },
        body: JSON.stringify({ raw }), signal: AbortSignal.timeout(10000),
      });
      (g.ok ? sent : failed).push(r.email);
    } catch { failed.push(r.email); }
  }

  try {
    await updateAppMeta(user, {
      sent_day: today, sent_today: sentToday + sent.length,
      emails_sent: Number(m.emails_sent || 0) + sent.length,
    });
  } catch {}
  send(res, 200, { sent, failed, skipped: unique.length - batch.length, cap: DAILY_SEND_CAP });
}
