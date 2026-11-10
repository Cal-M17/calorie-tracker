// Runs once a day from the Vercel cron job in vercel.json.
// Makes a few small database reads so Supabase doesn't pause the free project.
// Uses only the public (publishable) key, same as the app. Row-level security
// means it can't read anyone's data; the point is just to hit the database.
const SB_URL = process.env.SUPABASE_URL || "https://olrghmfqjenejdjcuoar.supabase.co";
const SB_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_rrpWdrvaoQy1JCTjLZAUTg_SxESVBXT";
const TABLES = ["households", "foods", "entries", "weights"];

module.exports = async (req, res) => {
  // If CRON_SECRET is set in Vercel, Vercel sends it automatically and we require it.
  const secret = process.env.CRON_SECRET;
  if (secret && (req.headers.authorization || "") !== "Bearer " + secret) {
    res.status(401).json({ error: "Unauthorised" });
    return;
  }
  const results = {};
  for (const t of TABLES) {
    try {
      const r = await fetch(`${SB_URL}/rest/v1/${t}?select=id&limit=1`, {
        headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY },
        cache: "no-store",
      });
      results[t] = r.status;
    } catch (e) {
      results[t] = "error";
    }
  }
  const ok = Object.values(results).some((s) => typeof s === "number" && s < 500);
  res.setHeader("Cache-Control", "no-store");
  res.status(ok ? 200 : 502).json({ ok, results, at: new Date().toISOString() });
};
