// Shared helpers for the Plate tracker server functions (Vercel, Node).
// Files starting with an underscore are not exposed as endpoints.
const SB_URL = process.env.SUPABASE_URL || "https://olrghmfqjenejdjcuoar.supabase.co";
const SB_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_rrpWdrvaoQy1JCTjLZAUTg_SxESVBXT";
const UA = "PlateTracker/1.0 (personal nutrition tracker)";

// Check the Supabase login token sent by the app. Returns the user, or null.
async function verify(req) {
  const a = req.headers.authorization || "";
  const tok = a.startsWith("Bearer ") ? a.slice(7) : "";
  if (!tok) return null;
  const r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_KEY, Authorization: "Bearer " + tok } });
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.id ? u : null;
}

const num = (x) => (x == null || x === "" || isNaN(+x) ? null : +x);
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

// Turn an Open Food Facts product into the app's shape (values per 100 g).
function norm(p) {
  const m = p.nutriments || {};
  let k = num(m["energy-kcal_100g"]);
  if (k == null && num(m["energy-kj_100g"]) != null) k = num(m["energy-kj_100g"]) / 4.184;
  const name = (p.product_name || "").trim();
  if (!name || k == null) return null;
  let salt = num(m.salt_100g);
  if (salt == null && num(m.sodium_100g) != null) salt = num(m.sodium_100g) * 2.5;
  const brand = (p.brands || "").split(",")[0].trim();
  const full = brand && !name.toLowerCase().includes(brand.toLowerCase()) ? brand + " " + name : name;
  return {
    code: String(p.code || ""),
    name: full.slice(0, 90),
    per100: {
      k: r1(k), p: r1(num(m.proteins_100g) ?? 0), c: r1(num(m.carbohydrates_100g) ?? 0), f: r1(num(m.fat_100g) ?? 0),
      fi: r1(num(m.fiber_100g)), su: r1(num(m.sugars_100g)), sa: r1(num(m["saturated-fat_100g"])), sl: r1(salt),
    },
    sg: num(p.serving_quantity),
  };
}

async function getJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctl.signal });
    if (!r.ok) throw new Error("status " + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

const FIELDS = "code,product_name,brands,nutriments,serving_quantity";

async function offSearch(q) {
  const qs = "search_terms=" + encodeURIComponent(q) + "&search_simple=1&action=process&json=1&page_size=12&fields=" + FIELDS;
  let j;
  try {
    j = await getJson("https://uk.openfoodfacts.org/cgi/search.pl?" + qs);
  } catch (e) {
    j = await getJson("https://world.openfoodfacts.org/cgi/search.pl?" + qs);
  }
  return (j.products || []).map(norm).filter(Boolean).slice(0, 8);
}

async function offCode(code) {
  const j = await getJson("https://world.openfoodfacts.org/api/v2/product/" + code + ".json?fields=" + FIELDS);
  return j && j.status === 1 && j.product ? norm({ ...j.product, code }) : null;
}

module.exports = { verify, offSearch, offCode, norm };
