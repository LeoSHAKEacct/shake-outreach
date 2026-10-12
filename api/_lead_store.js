import { SUPABASE_URL } from "./config.js";

// Every lead a user has found, kept in a private Supabase Storage bucket (one JSON file
// per user). It powers "My leads" and makes sure a new search never repeats a lead.
const BUCKET = "so-leads";
const MAX_KEEP = 3000;
const base = () => SUPABASE_URL.replace(/\/$/, "") + "/storage/v1";
const headers = extra => {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { apikey: key, Authorization: "Bearer " + key, ...extra };
};
const file = userId => encodeURIComponent(userId) + ".json";

export async function readLeads(userId) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return { leads: [], runs: [] };
  try {
    const r = await fetch(base() + "/object/authenticated/" + BUCKET + "/" + file(userId), {
      headers: headers(), signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return { leads: [], runs: [] };
    const d = await r.json();
    return { leads: Array.isArray(d.leads) ? d.leads : [], runs: Array.isArray(d.runs) ? d.runs : [] };
  } catch { return { leads: [], runs: [] }; }
}

async function put(userId, body) {
  return fetch(base() + "/object/" + BUCKET + "/" + file(userId), {
    method: "POST", headers: headers({ "Content-Type": "application/json", "x-upsert": "true" }),
    body, signal: AbortSignal.timeout(10000),
  });
}

export async function writeLeads(userId, data) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return false;
  const body = JSON.stringify({ leads: data.leads.slice(0, MAX_KEEP), runs: data.runs.slice(-200) });
  let r = await put(userId, body);
  if (!r.ok) {
    // First save ever: create the private bucket, then try again.
    await fetch(base() + "/bucket", {
      method: "POST", headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }), signal: AbortSignal.timeout(8000),
    }).catch(() => {});
    r = await put(userId, body);
  }
  return r.ok;
}

// The same business can show up with a different name or no email, so match on
// anything that identifies it: email, website, phone, or name + address.
const SHARED_HOSTS = /(^|\.)(facebook|instagram|google|linktr|linkedin|yelp|wix|business\.site|tiktok|x|twitter|youtube)\./;
export function leadKeys(l) {
  const keys = [];
  if (l.email) keys.push("e:" + String(l.email).toLowerCase().trim());
  try {
    const host = new URL(l.website).hostname.replace(/^www\./, "").toLowerCase();
    if (host && !SHARED_HOSTS.test(host + ".")) keys.push("w:" + host);
  } catch {}
  const digits = String(l.phone || "").replace(/\D/g, "");
  if (digits.length >= 7) keys.push("p:" + digits.slice(-9));
  if (!keys.length && l.name) keys.push("n:" + String(l.name).toLowerCase().trim() + "|" + String(l.address || "").toLowerCase().trim());
  return keys;
}
export function seenSet(leads) {
  const s = new Set();
  for (const l of leads) for (const k of leadKeys(l)) s.add(k);
  return s;
}
export const isSeen = (seen, l) => leadKeys(l).some(k => seen.has(k));
const norm = v => String(v || "").toLowerCase().trim();
export const sameSearch = (l, q, loc) => norm(l.q) === norm(q) && norm(l.loc) === norm(loc);
