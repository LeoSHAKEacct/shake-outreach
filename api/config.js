// Public settings the page needs. The Supabase publishable key is meant to be public;
// never put the secret / service_role key here.
export const SUPABASE_URL = process.env.SUPABASE_URL || "https://lgnfiveyqlehnxlvspqb.supabase.co";
export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_QATybwBpIxntiF_abGrEgw_Z9jvs9KC";
export default function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  if (req.query && req.query.health) return res.end(JSON.stringify({ ok: true, ai: Boolean(process.env.ANTHROPIC_API_KEY) }));
  res.setHeader("Cache-Control", "public, max-age=300");
  res.end(JSON.stringify({
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON_KEY,
    // Public OAuth client id, for Google's own sign-in button (shows our domain, not Supabase's).
    googleClientId: process.env.GOOGLE_CLIENT_ID || ""
  }));
}
