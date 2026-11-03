// GET /api/foods?q=<name> or ?code=<barcode>  ->  { items: [...] }  (Open Food Facts, per 100 g)
const L = require("./_lib");

module.exports = async (req, res) => {
  try {
    const u = await L.verify(req);
    if (!u) { res.status(401).json({ error: "Please sign in again." }); return; }
    const q = String(req.query.q || "").trim().slice(0, 80);
    const code = String(req.query.code || "").replace(/\D/g, "");
    let items = [];
    if (code.length >= 8 && code.length <= 14) {
      const p = await L.offCode(code);
      items = p ? [p] : [];
    } else if (q.length >= 2) {
      items = await L.offSearch(q);
    }
    res.status(200).json({ items });
  } catch (e) {
    res.status(502).json({ error: "The food database didn’t respond. Try again in a moment." });
  }
};
