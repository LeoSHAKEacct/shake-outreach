export default function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, ai: Boolean(process.env.ANTHROPIC_API_KEY) }));
}
