import { SUPABASE_URL } from "./config.js";
import { readState, seal, updateAppMeta } from "./_account.js";

function back(res, origin, result) {
  res.statusCode = 302;
  res.setHeader("Location", origin + "/?gmail=" + result + "#writer");
  res.end();
}

async function adminGetUser(id) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key };
  if (key.startsWith("eyJ")) headers.Authorization = "Bearer " + key;
  const r = await fetch(SUPABASE_URL.replace(/\/$/, "") + "/auth/v1/admin/users/" + id, { headers, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("user");
  return r.json();
}

export default async function handler(req, res) {
  const origin = "https://" + req.headers.host;
  const url = new URL(req.url, origin);
  if (url.searchParams.get("error")) return back(res, origin, "cancelled");
  const value = readState(url.searchParams.get("state"));
  if (!value) return back(res, origin, "error");
  const [uid, ts] = value.split(":");
  if (Date.now() - Number(ts) > 15 * 60 * 1000) return back(res, origin, "expired");
  try {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: url.searchParams.get("code") || "",
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: origin + "/api/gmail-callback",
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(10000),
    });
    const tok = await r.json();
    if (!r.ok || !tok.refresh_token) return back(res, origin, "error");
    const claims = JSON.parse(Buffer.from(String(tok.id_token).split(".")[1], "base64url").toString("utf8"));
    const user = await adminGetUser(uid);
    await updateAppMeta(user, { gmail: { email: claims.email, rt: seal(tok.refresh_token) } });
    return back(res, origin, "connected");
  } catch {
    return back(res, origin, "error");
  }
}
