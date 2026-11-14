// ../../../../mnt/user-data/outputs/swap-app/src/lib/scorer.ts
var SPELLING = [
  [/sulph/g, "sulf"],
  [/colour/g, "color"],
  [/flavour/g, "flavor"],
  [/aluminium/g, "aluminum"],
  [/caesium/g, "cesium"],
  [/\bfibre\b/g, "fiber"]
];
function normalise(text) {
  let t = text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[’'`´]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  for (const [from, to] of SPELLING) t = t.replace(from, to);
  return t.replace(/\s+/g, " ");
}
function additiveCode(text) {
  const m = normalise(text).match(/^(?:e|ins)?\s?(\d{3,4}[a-z]?)$/);
  return m ? m[1] : null;
}
var OPEN = "([{";
var CLOSE = ")]}";
function cleanLabelText(raw) {
  let t = (raw || "").replace(/\r/g, "").replace(/-\n\s*/g, "").replace(/\n+/g, " ").replace(/[_*]/g, "").replace(/\s+/g, " ").trim();
  t = t.replace(/^.*?\bingredients?\b\s*[:\-–]\s*/i, "");
  const cut = t.search(/\bmay contain\b|(?:^|[.;]\s*)(?:contains|allergens?|allergy advice|warning|caution|store|storage|directions|made in|product of|manufactured)\b/i);
  if (cut > 0) t = t.slice(0, cut);
  return t.replace(/[.;,\s]+$/, "").trim();
}
function splitTopLevel(text) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (OPEN.includes(ch)) depth++;
    else if (CLOSE.includes(ch)) depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === "," || ch === ";" || ch === "\u2022" || ch === "\xB7" || ch === "|")) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}
function tidyEntry(entry) {
  return entry.replace(/[([{]\s*\d+(?:[.,]\d+)?\s*%\s*[)\]}]/g, "").replace(/\b\d+(?:[.,]\d+)?\s*%/g, "").replace(/\s+/g, " ").replace(/^[\s.:\-–]+|[\s.:\-–]+$/g, "").trim();
}
function splitIngredients(raw) {
  return splitTopLevel(cleanLabelText(raw)).map(tidyEntry).filter(Boolean);
}
function partsOf(entry) {
  const parts = [];
  const walk = (text) => {
    let outer = "";
    let inner = "";
    let depth = 0;
    for (const ch of text) {
      if (OPEN.includes(ch)) {
        if (depth > 0) inner += ch;
        depth++;
      } else if (CLOSE.includes(ch)) {
        depth = Math.max(0, depth - 1);
        if (depth > 0) inner += ch;
        else {
          splitTopLevel(inner).forEach(walk);
          inner = "";
        }
      } else if (depth > 0) inner += ch;
      else outer += ch;
    }
    if (inner) splitTopLevel(inner).forEach(walk);
    const n = normalise(tidyEntry(outer));
    if (n) parts.push(n);
  };
  walk(entry);
  return parts;
}
var SEVERITY = { green: 0, yellow: 1, red: 2 };
function safeAsPhrase(alias) {
  return alias.length >= 5 || alias.includes(" ");
}
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function buildIndex(ingredients, domain) {
  const codes = /* @__PURE__ */ new Map();
  const exact = /* @__PURE__ */ new Map();
  const phrases = [];
  const exactOnlySet = /* @__PURE__ */ new Set();
  const prefer = (a, b) => {
    if (!a) return b;
    const d = SEVERITY[b.rating] - SEVERITY[a.rating];
    return d > 0 || d === 0 && b.id < a.id ? b : a;
  };
  for (const ing of ingredients) {
    if (ing.domain !== "all" && ing.domain !== domain) continue;
    for (const raw of [ing.canonical_name, ...ing.aliases || []]) {
      if (!raw) continue;
      const exactOnly = raw.startsWith("=");
      const name = exactOnly ? raw.slice(1) : raw;
      const code = additiveCode(name);
      if (code) {
        if (domain === "food") codes.set(code, prefer(codes.get(code), ing));
        continue;
      }
      const alias = normalise(name);
      if (!alias) continue;
      exact.set(alias, prefer(exact.get(alias), ing));
      if (exactOnly) exactOnlySet.add(alias);
    }
  }
  for (const [alias, ingredient] of exact) {
    if (!safeAsPhrase(alias) || exactOnlySet.has(alias)) continue;
    phrases.push({ alias, ingredient, pattern: new RegExp(`(?:^| )${escapeRegExp(alias)}(?= |$)`) });
  }
  phrases.sort((a, b) => b.alias.length - a.alias.length || (a.alias < b.alias ? -1 : 1));
  return { codes, exact, phrases };
}
function codesIn(entry) {
  const found = [];
  const re = /(?:^|[^a-z0-9])(?:e|ins)?[\s-]?(\d{3,4}[a-z]?)(?![a-z0-9])/gi;
  let m;
  const text = entry.toLowerCase();
  while (m = re.exec(text)) {
    found.push(m[1]);
    re.lastIndex = m.index + 1;
  }
  return found;
}
function matchEntry(entry, index) {
  const hits = /* @__PURE__ */ new Map();
  const add = (hit) => {
    if (!hits.has(hit.ingredient.id)) hits.set(hit.ingredient.id, hit);
  };
  for (const code of codesIn(entry)) {
    const ing = index.codes.get(code) || index.codes.get(code.replace(/[a-z]$/, ""));
    if (ing) add({ ingredient: ing, matched_on: code, match_type: "code" });
  }
  const whole = normalise(entry);
  for (const part of /* @__PURE__ */ new Set([whole, ...partsOf(entry)])) {
    const ing = index.exact.get(part);
    if (ing) add({ ingredient: ing, matched_on: part, match_type: "exact" });
  }
  let remaining = whole;
  for (const { alias, pattern, ingredient } of index.phrases) {
    if (remaining.length < alias.length) continue;
    const m = pattern.exec(remaining);
    if (!m) continue;
    remaining = remaining.slice(0, m.index) + " ".repeat(m[0].length) + remaining.slice(m.index + m[0].length);
    add({ ingredient, matched_on: alias, match_type: "phrase" });
  }
  return [...hits.values()];
}
function worstRating(ratings) {
  if (!ratings.length) return null;
  return ratings.reduce((worst, r) => SEVERITY[r] > SEVERITY[worst] ? r : worst, "green");
}
function createScorer(ingredients) {
  const cache = /* @__PURE__ */ new Map();
  const indexFor = (domain) => {
    let idx = cache.get(domain);
    if (!idx) cache.set(domain, idx = buildIndex(ingredients, domain));
    return idx;
  };
  return {
    score(rawIngredientsText, domain) {
      const entries = splitIngredients(rawIngredientsText);
      const index = indexFor(domain);
      const parsed = [];
      const seen = /* @__PURE__ */ new Set();
      for (const entry of entries) {
        const hits = matchEntry(entry, index).filter((h) => !seen.has(h.ingredient.id));
        if (!hits.length) {
          if (!matchEntry(entry, index).length) parsed.push({ text: entry, matched: false });
          continue;
        }
        for (const h of hits) {
          seen.add(h.ingredient.id);
          parsed.push({
            text: entry,
            matched: true,
            ingredient_id: h.ingredient.id,
            canonical_name: h.ingredient.canonical_name,
            rating: h.ingredient.rating,
            matched_on: h.matched_on,
            match_type: h.match_type
          });
        }
      }
      const ratings = parsed.filter((p) => p.matched).map((p) => p.rating);
      const count = (r) => ratings.filter((x) => x === r).length;
      return {
        parsed_ingredients: parsed,
        // With entries but no flagged matches, nothing of concern was found: green.
        // With no entries at all, we can't say anything: null.
        overall_rating: entries.length ? worstRating(ratings) ?? "green" : null,
        red_count: count("red"),
        yellow_count: count("yellow"),
        green_count: count("green"),
        unmatched_count: parsed.filter((p) => !p.matched).length
      };
    }
  };
}
function scoreIngredients(rawIngredientsText, domain, ingredients) {
  return createScorer(ingredients).score(rawIngredientsText, domain);
}
export {
  additiveCode,
  cleanLabelText,
  createScorer,
  normalise,
  scoreIngredients,
  splitIngredients,
  worstRating
};
