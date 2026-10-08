import crypto from "node:crypto";

// Shared Apify helpers. The token only ever lives in the APIFY_TOKEN env var.
const API = "https://api.apify.com/v2";

export async function apify(path, init = {}) {
  const r = await fetch(API + path, {
    ...init,
    headers: { Authorization: "Bearer " + process.env.APIFY_TOKEN, "Content-Type": "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(15000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw { status: r.status, data };
  return data;
}

export async function startRun(actor, input) {
  const run = await apify(`/acts/${actor}/runs`, { method: "POST", body: JSON.stringify(input) });
  return { runId: run.data.id, datasetId: run.data.defaultDatasetId };
}

// Tickets let the browser poll a run without being able to read anyone else's.
function sign(payload) {
  return crypto.createHmac("sha256", process.env.APIFY_TOKEN).update(payload).digest("base64url");
}
export function makeTicket(parts) {
  const payload = parts.join(".");
  return payload + "." + sign(payload);
}
export function readTicket(ticket, count) {
  const parts = String(ticket || "").split(".");
  if (parts.length !== count + 1) return null;
  const payload = parts.slice(0, count).join(".");
  const a = Buffer.from(sign(payload)), b = Buffer.from(parts[count]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return parts.slice(0, count);
}
