import { fetchHtml } from "./_claude.js";

// Free leads for trial accounts: businesses from OpenStreetMap (open data),
// plus an email finder that reads each business's own website.
const UA = { "User-Agent": "ShakeOutreach/1.0 (contact@shakeapp.today)" };
const OVERPASS = "https://overpass-api.de/api/interpreter";

async function geocode(location) {
  const r = await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(location),
    { headers: UA, signal: AbortSignal.timeout(8000) });
  const list = await r.json().catch(() => []);
  return list[0] || null;
}

// "key=value" tags from the analysis, e.g. "amenity=dentist"; falls back to a name search.
function selectors(tags, term) {
  const clean = (Array.isArray(tags) ? tags : [])
    .map(t => String(t).split("="))
    .filter(([k, v]) => /^[a-z:_]{2,30}$/.test(k || "") && /^[\w\-;. ]{1,40}$/.test(v || ""))
    .slice(0, 5);
  if (clean.length) return clean.map(([k, v]) => `nwr["${k}"="${v}"]`);
  const safe = String(term || "").replace(/["\\]/g, "").slice(0, 40);
  return safe ? [`nwr["name"~"${safe}",i]`] : [];
}

function toLead(el) {
  const t = el.tags || {};
  const addr = [t["addr:street"] && (t["addr:street"] + (t["addr:housenumber"] ? " " + t["addr:housenumber"] : "")), t["addr:city"]].filter(Boolean).join(", ");
  let website = t.website || t["contact:website"] || t.url || "";
  if (website && !/^https?:\/\//i.test(website)) website = "https://" + website;
  return {
    name: String(t.name || ""),
    email: String(t.email || t["contact:email"] || "").split(/[;,\s]/)[0],
    phone: String(t.phone || t["contact:phone"] || "").split(";")[0],
    website, address: addr, rating: null,
    maps: "https://www.openstreetmap.org/" + el.type + "/" + el.id,
  };
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
function pickEmail(html, site) {
  const found = [...new Set((html.match(EMAIL_RE) || []).map(e => e.toLowerCase()))]
    .filter(e => !/\.(png|jpe?g|gif|svg|webp|css|js)$/.test(e) && !/(example\.|sentry|wixpress|domain\.com|email\.com|yourmail|godaddy)/.test(e));
  let host = "";
  try { host = new URL(site).hostname.replace(/^www\./, ""); } catch {}
  return found.find(e => host && e.endsWith("@" + host)) || found[0] || "";
}
async function findEmail(site) {
  const home = await fetchHtml(site, 6000);
  let email = pickEmail(home, site);
  if (email) return email;
  for (const path of ["/contacto", "/contact", "/contact-us", "/contactanos"]) {
    let u; try { u = new URL(path, site).toString(); } catch { return ""; }
    email = pickEmail(await fetchHtml(u, 5000), site);
    if (email) return email;
  }
  return "";
}

export async function freeLeads({ tags, term, location, max = 20 }) {
  const place = await geocode(location);
  if (!place) throw { code: "no_place" };
  const sels = selectors(tags, term);
  if (!sels.length) throw { code: "no_query" };
  let scope;
  if (place.osm_type === "relation") scope = { def: `area(${3600000000 + Number(place.osm_id)})->.a;`, f: "(area.a)" };
  else {
    const [s, n, w, e] = (place.boundingbox || []).map(Number);
    scope = { def: "", f: `(${s},${w},${n},${e})` };
  }
  const q = `[out:json][timeout:25];${scope.def}(${sels.map(x => x + scope.f + ";").join("")});out center tags 150;`;
  const r = await fetch(OVERPASS, { method: "POST", headers: { ...UA, "Content-Type": "application/x-www-form-urlencoded" },
    body: "data=" + encodeURIComponent(q), signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw { code: "free_source_busy" };
  const data = await r.json().catch(() => ({}));
  const seen = new Set();
  let leads = (data.elements || []).map(toLead).filter(l => l.name && !seen.has(l.name.toLowerCase()) && seen.add(l.name.toLowerCase()));
  // Prefer places we can actually reach: email first, then website.
  leads.sort((a, b) => (b.email ? 2 : b.website ? 1 : 0) - (a.email ? 2 : a.website ? 1 : 0));
  leads = leads.slice(0, max);

  // Read websites (6 at a time) to find emails that OpenStreetMap doesn't list.
  const todo = leads.filter(l => !l.email && l.website);
  const started = Date.now();
  for (let i = 0; i < todo.length && Date.now() - started < 35000; i += 6) {
    await Promise.all(todo.slice(i, i + 6).map(async l => { l.email = await findEmail(l.website).catch(() => ""); }));
  }
  return leads;
}
