// Public settings the page needs. The Supabase publishable key is meant to be public;
// never put the secret / service_role key here.
export const SUPABASE_URL = process.env.SUPABASE_URL || "https://fjwofvidxiydycftjhvs.supabase.co";
export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_CfSYcvQ4NNyaxE0XAXhxZQ_SJ7fb0Sq";
export default function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.end(JSON.stringify({
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON_KEY
  }));
}
