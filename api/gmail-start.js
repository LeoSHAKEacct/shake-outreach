import { requireUser, send } from "./_claude.js";
import { signState, tracking } from "./_account.js";

// Returns the Google consent URL that lets Shake Outreach send email from the user's Gmail.
export default async function handler(req, res) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !tracking()) {
    return send(res, 503, { error: "gmail_not_configured" });
  }
  const user = await requireUser(req);
  if (!user || !user.id) return send(res, 401, { error: "auth_required" });
  const origin = "https://" + req.headers.host;
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: origin + "/api/gmail-callback",
    response_type: "code",
    scope: "openid email https://www.googleapis.com/auth/gmail.send",
    access_type: "offline",
    prompt: "consent",
    state: signState(user.id + ":" + Date.now()),
  });
  send(res, 200, { url: "https://accounts.google.com/o/oauth2/v2/auth?" + params });
}
