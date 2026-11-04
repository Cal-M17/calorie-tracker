// POST /api/chat  { messages, context, mode, deepLeft }  ->  { reply, actions, tier, usage }
//
// Two models share the work to stay inside the free daily limits:
//   quick = GEMINI_LITE_MODEL (default gemini-3.5-flash-lite), for logging and simple questions
//   deep  = GEMINI_DEEP_MODEL (default gemini-3.6-flash), for planning, suggestions and analysis
// Most messages cost ONE model call. The server finds likely foods itself, the model answers in JSON,
// and it only asks for a second call when it needs a product-database lookup.
const L = require("./_lib");
const LITE = process.env.GEMINI_LITE_MODEL || "gemini-3.5-flash-lite";
const DEEP = process.env.GEMINI_DEEP_MODEL || "gemini-3.6-flash";
const MEALS = ["Breakfast", "Lunch", "Dinner", "Snacks"];

const hits = new Map();
function limited(id) {
  const now = Date.now();
  const a = (hits.get(id) || []).filter((t) => now - t < 600000);
  if (a.length >= 25) { hits.set(id, a); return true; }
  a.push(now); hits.set(id, a);
  return false;
}

const low = (s) => String(s || "").toLowerCase();
const COMPLEX = /\b(plan|planning|week|weekly|meal ?prep|suggest|suggestions?|ideas?|recipes?|what (can|should|could|shall) i (make|eat|cook|have)|compare|why|explain|review|analy[sz]e|trend|progress|adjust|improve|balance|swap|alternatives?|shopping|menu|how (am|do|can|should) i)\b/i;
function isComplex(t) {
  return COMPLEX.test(t) || t.length > 240 || (t.match(/\?/g) || []).length > 1;
}

const STOP = new Set(["the", "and", "with", "for", "had", "have", "ate", "log", "add", "some", "please", "this", "that", "was", "just", "about", "two", "three", "one", "half", "today", "yesterday", "breakfast", "lunch", "dinner", "snack", "snacks", "both", "from", "into", "much", "what", "how", "can", "you", "are", "our", "has", "got"]);
const stem = (w) => w.replace(/ies$/, "y").replace(/(es|s)$/, "");
const words = (s) => low(s).replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).map(stem);

// Pick the user's own foods and recipes that look relevant to what they typed.
function candidates(ctx, text, deep) {
  const items = Array.isArray(ctx.items) ? ctx.items : [];
  const q = [...new Set(words(text))];
  const scored = items.map((i) => {
    const iw = words(i.name);
    const hit = iw.filter((w) => q.some((x) => x === w || (x.length > 3 && w.length > 3 && (w.startsWith(x) || x.startsWith(w))))).length;
    return [i, hit];
  }).filter((a) => a[1] > 0).sort((a, b) => b[1] - a[1]).map((a) => a[0]);
  if (!deep) return scored.slice(0, 20);
  const out = [], seen = new Set();
  [...scored.slice(0, 30), ...items.filter((i) => i.type === "recipe").slice(0, 40), ...items].forEach((i) => {
    if (out.length < 120 && !seen.has(i.id)) { seen.add(i.id); out.push(i); }
  });
  return out;
}

const SCHEMA = {
  type: "OBJECT",
  properties: {
    reply: { type: "STRING" },
    escalate: { type: "BOOLEAN" },
    search: { type: "ARRAY", items: { type: "STRING" } },
    log: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          profile: { type: "STRING" },
          meal: { type: "STRING", enum: MEALS },
          date: { type: "STRING" },
          source: { type: "STRING", enum: ["my_food", "my_recipe", "database"] },
          id: { type: "STRING" },
          code: { type: "STRING" },
          unit: { type: "STRING", enum: ["servings", "grams"] },
          amount: { type: "NUMBER" },
        },
        required: ["profile", "meal", "date", "source", "unit", "amount"],
      },
    },
  },
  required: ["reply"],
};

function systemPrompt(ctx, cands, dbRes, tier) {
  const { items, ...rest } = ctx;
  const slim = (i) => ({ id: i.id, name: i.name, type: i.type, per100g: i.per100, serving_g: i.serving_g });
  return [
    "You are the assistant inside a personal nutrition tracker, chatting on a phone. Reply in plain text, short and practical, with at most a short list.",
    "Answer with JSON only, using these fields: reply (text for the user), log (foods to line up for logging, optional), search (product-database search terms, optional), escalate (boolean, optional).",
    "The user tracks food for the profiles in the context and may log for either or both. Use the active profile unless they name one or say both. Default the date to today. Pick the meal from what they say or the time of day.",
    "To log food, put it in log using ids from MY FOODS AND RECIPES, or codes from DATABASE RESULTS. The app shows a confirmation card, so say you have lined it up to confirm, never that it is already logged. If an amount, meal or profile is unclear, ask one short question in reply and leave log empty.",
    "If something they ate is in neither list, do not guess. Add a short product search term to search (at most 3) and tell them you are checking the database. Never invent nutrition numbers or ids.",
    "When suggesting meals, say roughly how they fit the remaining calories and macros for today, and prefer foods and recipes they already have.",
    "The sugar limit applies to free sugars, not the natural sugars in whole fruit, vegetables or plain milk. Use free_sugars figures when present and say when they are missing.",
    "Stay within their calorie floor and weekly rate limits. No medical advice, no encouragement of extreme restriction, and suggest a GP if intake or weight loss looks extreme or they mention symptoms.",
    tier === "quick" ? "You are the quick model. If the request needs meal planning, multi-day analysis, recipe design or careful reasoning, set escalate to true and keep reply short." : "Think carefully, but keep the reply concise.",
    "CONTEXT: " + JSON.stringify(rest),
    "MY FOODS AND RECIPES (ids you may use): " + JSON.stringify(cands.map(slim)),
    dbRes.length ? "DATABASE RESULTS: " + JSON.stringify(dbRes) : "",
  ].filter(Boolean).join("\n");
}

function trim(ctx) {
  const c = typeof ctx === "object" && ctx ? ctx : {};
  c.items = (Array.isArray(c.items) ? c.items : []).slice(0, 400);
  if (Array.isArray(c.profiles)) c.profiles = c.profiles.slice(0, 4).map((p) => ({ ...p, days: (p.days || []).slice(-14), weights: (p.weights || []).slice(-10) }));
  c.today = /^\d{4}-\d{2}-\d{2}$/.test(c.today || "") ? c.today : new Date().toISOString().slice(0, 10);
  return c;
}

async function callGemini(key, model, sys, contents) {
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: sys }] },
      contents,
      generationConfig: { temperature: 0.3, maxOutputTokens: 1500, responseMimeType: "application/json", responseSchema: SCHEMA },
    }),
  });
  if (!r.ok) { const e = new Error("gemini " + r.status); e.status = r.status; throw e; }
  return r.json();
}

function parse(data) {
  const cand = data && data.candidates && data.candidates[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  let t = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("").trim();
  t = t.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    const o = JSON.parse(t);
    return o && typeof o === "object" ? o : { reply: String(o) };
  } catch (e) {
    return { reply: t };
  }
}

async function searchDb(terms, found) {
  const out = await Promise.all(terms.map(async (t) => {
    let items = [];
    try { items = await L.offSearch(String(t).slice(0, 80)); } catch (e) { items = []; }
    items.forEach((i) => found.set(i.code, i));
    return { search: t, results: items.slice(0, 6).map((i) => ({ code: i.code, name: i.name, per100g: i.per100, serving_g: i.sg })) };
  }));
  return out;
}

function buildActions(log, ctx, found) {
  const actions = [], errs = [];
  for (const e of Array.isArray(log) ? log : []) {
    const unit = e.unit === "grams" ? "g" : "servings";
    const amount = +e.amount;
    if (!(amount > 0)) { errs.push("an amount was missing"); continue; }
    const a = { profile: String(e.profile || ""), meal: MEALS.includes(e.meal) ? e.meal : "Snacks", date: /^\d{4}-\d{2}-\d{2}$/.test(e.date || "") ? e.date : ctx.today, unit, amount };
    if (e.source === "database") {
      const f = found.get(String(e.code || ""));
      if (!f) { errs.push("a product wasn’t found in the database"); continue; }
      if (unit === "servings" && !f.sg) { errs.push(f.name + " has no serving size, so give me grams"); continue; }
      a.kind = "database"; a.name = f.name; a.food = { name: f.name, ...f.per100, sg: f.sg || 0 };
    } else {
      const it = (ctx.items || []).find((i) => i.id === e.id);
      if (!it) { errs.push("one of the foods isn’t in your library"); continue; }
      a.kind = it.type === "recipe" ? "my_recipe" : "my_food"; a.id = it.id; a.name = it.name;
    }
    actions.push(a);
  }
  return { actions, errs };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  try {
    const u = await L.verify(req);
    if (!u) { res.status(401).json({ error: "Please sign in again." }); return; }
    if (limited(u.id)) { res.status(429).json({ error: "That’s a lot of messages. Try again in a few minutes." }); return; }
    const key = process.env.GEMINI_API_KEY;
    if (!key) { res.status(500).json({ error: "The AI key isn’t set up on the server yet." }); return; }
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const contents = (Array.isArray(body.messages) ? body.messages : []).slice(-10).map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: String(m.text || "").slice(0, 1500) }] }));
    while (contents.length && contents[0].role !== "user") contents.shift();
    if (!contents.length || contents[contents.length - 1].role !== "user") { res.status(400).json({ error: "No message to answer." }); return; }
    const ctx = trim(body.context);
    const userTexts = contents.filter((c) => c.role === "user").slice(-3).map((c) => c.parts[0].text);
    const lastText = userTexts[userTexts.length - 1];
    const deepLeft = Number.isFinite(+body.deepLeft) ? +body.deepLeft : 20;
    let tier = deepLeft > 0 && (body.mode === "deep" || isComplex(lastText)) ? "deep" : "quick";
    const usage = { lite: 0, deep: 0 };
    const found = new Map();
    let dbRes = [], searched = false, out = { reply: "" }, usedModel = "";

    const ask = async () => {
      const order = tier === "deep" ? [DEEP, LITE] : deepLeft > 0 ? [LITE, DEEP] : [LITE];
      const sys = systemPrompt(ctx, candidates(ctx, userTexts.join(" "), tier === "deep"), dbRes, tier);
      let lastErr;
      for (const m of order) {
        try {
          const data = await callGemini(key, m, sys, contents);
          usage[m === DEEP ? "deep" : "lite"]++;
          usedModel = m;
          return parse(data);
        } catch (e) {
          lastErr = e;
          if (![429, 500, 502, 503, 504].includes(e.status)) throw e;
        }
      }
      throw lastErr;
    };

    for (let i = 0; i < 3; i++) {
      out = await ask();
      if (Array.isArray(out.search) && out.search.length && !searched) {
        searched = true;
        dbRes = await searchDb(out.search.slice(0, 3), found);
        continue;
      }
      if (out.escalate && tier === "quick" && deepLeft > 0) { tier = "deep"; continue; }
      break;
    }

    const { actions, errs } = buildActions(out.log, ctx, found);
    let reply = String(out.reply || "").trim();
    if (!reply) reply = actions.length ? "I’ve lined that up for you to confirm." : "Sorry, I couldn’t work that out. Could you try asking another way?";
    if (errs.length) reply += "\n\n(I couldn’t line up some items: " + [...new Set(errs)].join("; ") + ".)";
    res.status(200).json({ reply, actions, tier: usedModel === DEEP ? "deep" : "quick", usage });
  } catch (e) {
    const s = e && e.status;
    const msg = s === 429 ? "Both AI models have hit their free limits for now. Try again later." : s === 404 || s === 400 ? "An AI model setting looks wrong. Check the model names in Vercel." : "The AI service didn’t respond. Try again in a moment.";
    res.status(s === 429 ? 429 : 502).json({ error: msg });
  }
};
