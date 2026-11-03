// POST /api/chat  { messages: [{role, text}], context: {...} }  ->  { reply, actions }
// The AI key lives only here, as the GEMINI_API_KEY setting in Vercel. Set GEMINI_MODEL to change the model.
const L = require("./_lib");
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const MEALS = ["Breakfast", "Lunch", "Dinner", "Snacks"];

// Best-effort limit per person (serverless instances come and go, so this is a soft guard).
const hits = new Map();
function limited(id) {
  const now = Date.now();
  const a = (hits.get(id) || []).filter((t) => now - t < 600000);
  if (a.length >= 25) { hits.set(id, a); return true; }
  a.push(now); hits.set(id, a);
  return false;
}

const Q = { type: "OBJECT", properties: { query: { type: "STRING", description: "Words to look for, for example chicken or chilli" } }, required: ["query"] };
const TOOLS = [{
  functionDeclarations: [
    { name: "search_my_foods", description: "Search the user's own saved foods and recipes by name. Returns ids, nutrition per 100 g and serving size in grams. Use an empty query to list recipes. Always use this before suggesting meals from their ingredients or logging something they might already have saved.", parameters: Q },
    { name: "search_food_database", description: "Search the Open Food Facts UK database for packaged products that are not in the user's own library. Returns codes and nutrition per 100 g.", parameters: Q },
    {
      name: "propose_log",
      description: "Line up food to be logged. The app shows the user a confirmation card and nothing is saved until they tap Confirm.",
      parameters: {
        type: "OBJECT",
        properties: {
          entries: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                profile: { type: "STRING", description: "Profile name exactly as in the context" },
                meal: { type: "STRING", enum: MEALS },
                date: { type: "STRING", description: "YYYY-MM-DD" },
                source: { type: "STRING", enum: ["my_food", "my_recipe", "database"] },
                id: { type: "STRING", description: "id from search_my_foods (my_food or my_recipe)" },
                code: { type: "STRING", description: "code from search_food_database (database)" },
                unit: { type: "STRING", enum: ["servings", "grams"] },
                amount: { type: "NUMBER" },
              },
              required: ["profile", "meal", "date", "source", "unit", "amount"],
            },
          },
        },
        required: ["entries"],
      },
    },
  ],
}];

const low = (s) => String(s || "").toLowerCase();

function searchMine(ctx, q) {
  const its = Array.isArray(ctx.items) ? ctx.items : [];
  const words = low(q).split(/\s+/).filter(Boolean);
  let hit = !words.length ? its.filter((i) => i.type === "recipe") : its.filter((i) => words.every((w) => low(i.name).includes(w)));
  if (!hit.length && words.length) hit = its.filter((i) => words.some((w) => low(i.name).includes(w)));
  return hit.slice(0, 10);
}

function propose(args, ctx, found, actions) {
  const errs = [];
  let n = 0;
  for (const e of args.entries || []) {
    const unit = e.unit === "grams" ? "g" : "servings";
    const amount = +e.amount;
    if (!(amount > 0)) { errs.push("Amount must be above zero."); continue; }
    const a = { profile: String(e.profile || ""), meal: MEALS.includes(e.meal) ? e.meal : "Snacks", date: /^\d{4}-\d{2}-\d{2}$/.test(e.date || "") ? e.date : ctx.today, unit, amount };
    if (e.source === "database") {
      const f = found.get(String(e.code || ""));
      if (!f) { errs.push("Unknown code " + e.code + ". Run search_food_database first."); continue; }
      if (unit === "servings" && !f.sg) { errs.push(f.name + " has no serving size, so use grams."); continue; }
      a.kind = "database"; a.name = f.name; a.food = { name: f.name, ...f.per100, sg: f.sg || 0 };
    } else {
      const it = (ctx.items || []).find((i) => i.id === e.id);
      if (!it) { errs.push("Unknown id " + e.id + ". Run search_my_foods first."); continue; }
      a.kind = it.type === "recipe" ? "my_recipe" : "my_food"; a.id = it.id; a.name = it.name;
    }
    actions.push(a); n++;
  }
  return errs.length ? { queued: n, errors: errs } : { queued: n, note: "Shown to the user for confirmation. Do not say it has been logged yet." };
}

async function runTool(name, args, ctx, found, actions) {
  if (name === "search_my_foods") {
    return { results: searchMine(ctx, args.query).map((i) => ({ id: i.id, name: i.name, type: i.type, per100g: i.per100, serving_g: i.serving_g })) };
  }
  if (name === "search_food_database") {
    const items = await L.offSearch(String(args.query || "").slice(0, 80));
    items.forEach((i) => found.set(i.code, i));
    return { results: items.slice(0, 6).map((i) => ({ code: i.code, name: i.name, per100g: i.per100, serving_g: i.sg })) };
  }
  if (name === "propose_log") return propose(args, ctx, found, actions);
  return { error: "Unknown tool" };
}

function systemPrompt(ctx) {
  const { items, ...rest } = ctx;
  return [
    "You are the assistant inside a personal nutrition tracker, chatting on a phone. Keep replies short, warm and practical, in plain text with at most a short list.",
    "The user tracks food for the profiles listed in the context and may log for either or both. Unless they name a profile or say both, use the active profile.",
    "Use search_my_foods before suggesting meals from their ingredients, and before logging anything they may have saved. Use search_food_database for packaged products they don't have saved. Never invent nutrition numbers: use tool results or the context.",
    "To log food, call propose_log. The app shows a confirmation card, so say you've lined it up to confirm, never that it is already logged. If an amount, meal or profile is unclear, ask one short question first. Default the date to today and pick the meal from what they say or the time of day.",
    "When suggesting meals, say roughly how they fit the remaining calories and macros for the day, and prefer foods and recipes they already have.",
    "Stay within their calorie floor and weekly rate limits. Don't give medical advice, don't encourage extreme restriction, and suggest speaking to a GP if intake or weight loss looks extreme or they mention symptoms.",
    "Context (their data, today's date and each profile's targets and recent days): " + JSON.stringify(rest),
  ].join("\n");
}

function trim(ctx) {
  const c = typeof ctx === "object" && ctx ? ctx : {};
  c.items = (Array.isArray(c.items) ? c.items : []).slice(0, 400);
  if (Array.isArray(c.profiles)) c.profiles = c.profiles.slice(0, 4).map((p) => ({ ...p, days: (p.days || []).slice(-14), weights: (p.weights || []).slice(-10) }));
  c.today = /^\d{4}-\d{2}-\d{2}$/.test(c.today || "") ? c.today : new Date().toISOString().slice(0, 10);
  return c;
}

async function callGemini(key, sys, contents) {
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + MODEL + ":generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents, tools: TOOLS, generationConfig: { temperature: 0.4, maxOutputTokens: 1500 } }),
  });
  if (!r.ok) { const e = new Error("gemini " + r.status); e.status = r.status; throw e; }
  return r.json();
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
    let contents = (Array.isArray(body.messages) ? body.messages : []).slice(-12).map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: String(m.text || "").slice(0, 2000) }] }));
    while (contents.length && contents[0].role !== "user") contents.shift();
    if (!contents.length || contents[contents.length - 1].role !== "user") { res.status(400).json({ error: "No message to answer." }); return; }
    const ctx = trim(body.context);
    const sys = systemPrompt(ctx);
    const found = new Map(), actions = [];
    let reply = "";
    for (let i = 0; i < 6; i++) {
      const r = await callGemini(key, sys, contents);
      const cand = r.candidates && r.candidates[0];
      if (!cand || !cand.content) break;
      const parts = cand.content.parts || [];
      const calls = parts.filter((p) => p.functionCall);
      if (!calls.length) { reply = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("").trim(); break; }
      contents.push(cand.content);
      const out = [];
      for (const p of calls) {
        const c = p.functionCall;
        let result;
        try { result = await runTool(c.name, c.args || {}, ctx, found, actions); } catch (e) { result = { error: "That lookup failed. Try again or answer without it." }; }
        out.push({ functionResponse: { name: c.name, response: { result }, ...(c.id ? { id: c.id } : {}) } });
      }
      contents.push({ role: "user", parts: out });
    }
    if (!reply) reply = actions.length ? "I’ve lined that up for you to confirm." : "Sorry, I couldn’t work that out. Could you try asking another way?";
    res.status(200).json({ reply, actions });
  } catch (e) {
    const s = e && e.status;
    const msg = s === 429 ? "The AI’s free limit has been reached for now. Try again later." : s === 404 || s === 400 ? "The AI model setting looks wrong. Check GEMINI_MODEL in Vercel." : "The AI service didn’t respond. Try again in a moment.";
    res.status(s === 429 ? 429 : 502).json({ error: msg });
  }
};
