// build-anchors.mjs — writes dashboard/data-anchors.js: the trading anchors
// (name, category, TVL, market cap, whether the anchor is in the fit) that
// the dashboard's method panel plots against the fitted size curve and that
// its board can show as reference rows.
//
// board.json deliberately carries no anchor list, so this generator rebuilds
// the anchor set from the snapshot with the same classification and fit code
// main.ts runs (Blok 1-2 of this entry, written for it), and then PROVES the
// rebuild is the same set main.ts used: the counts must match board.json's
// universe block and a refit on the rebuilt set must reproduce board.json's
// published coefficients to the six decimals board.json prints. If any check
// fails the script exits non-zero and writes nothing.
//
// Usage: node tools/build-anchors.mjs --snapshot <snapshot.json>
//          --board <board.json> --out <data-anchors.js>

import { readFileSync, writeFileSync } from "node:fs";

const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
};
const snapshotPath = argOf("--snapshot");
const boardPath = argOf("--board");
const outPath = argOf("--out");
if (!snapshotPath || !boardPath || !outPath) {
  console.error("usage: build-anchors.mjs --snapshot S --board B --out O");
  process.exit(2);
}
const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
const board = JSON.parse(readFileSync(boardPath, "utf8"));
const asOf = snapshot.as_of;

// --- helpers, mirroring main.ts -------------------------------------------

function median(xs) {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}
const EXCHANGE_PREFIXES = ["Binance", "Coinbase", "Bybit", "Kraken", "Bitget", "OKX", "Bitfinex", "Gemini"];
const STAKED_PRODUCT_CATEGORIES = new Set(["Liquid Staking", "Liquid Restaking", "Restaked BTC"]);
const BRIDGE_CATEGORIES = new Set(["Bridge", "Canonical Bridge", "Cross Chain Bridge"]);
function hasWholeWord(name, word) {
  return new RegExp(`\\b${word}\\b`, "i").test(name);
}
function hasVersionMarker(name) {
  return /\s(V\d+|v\d+|\d+\.0)\s*$/.test(name.trim());
}
function familyKeyOf(name) {
  return name
    .replace(/\s+(V\d+|v\d+|\d+\.0)\s*$/, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
function slugBaseOf(slug) {
  return slug.replace(/-v\d+$/, "");
}
function categoryOf(p) {
  return p.category == null ? "(uncategorized)" : p.category;
}
function daysBetween(isoDay, asOfDay) {
  const ms = Date.parse(asOfDay) - Date.parse(isoDay);
  return Math.max(0, Math.round(ms / 86400000));
}

// --- classification, mirroring main.ts classifyUniverse --------------------

function classifyUniverse(snap) {
  const protocols = snap.protocols;
  const setAside = new Map();
  const aside = (p, reason) => setAside.set(p.slug, reason);
  const withToken = protocols.filter((p) => p.mcap_usd != null && p.mcap_usd > 0);
  const byTicker = new Map();
  for (const p of withToken) {
    const ticker = String(p.symbol).toUpperCase();
    if (!byTicker.has(ticker)) byTicker.set(ticker, []);
    byTicker.get(ticker).push(p);
  }
  const anchors = [];
  for (const group of byTicker.values()) {
    const sorted = [...group].sort(
      (a, b) => b.mcap_usd - a.mcap_usd || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1)
    );
    anchors.push(sorted[0]);
    for (const loser of sorted.slice(1)) aside(loser, "duplicate_ticker");
  }
  const anchorSlugs = new Set(anchors.map((p) => p.slug));
  const tradingFamilies = new Set();
  for (const p of anchors) {
    tradingFamilies.add(familyKeyOf(p.name));
    tradingFamilies.add(slugBaseOf(p.slug));
  }
  const ranked = [];
  for (const p of protocols) {
    if (anchorSlugs.has(p.slug) || setAside.has(p.slug)) continue;
    if (p.symbol != null || p.gecko_id != null || p.mcap_usd != null) {
      aside(p, "token_no_mcap");
    } else if (p.tvl_usd <= 0) {
      aside(p, "zero_tvl");
    } else if (
      STAKED_PRODUCT_CATEGORIES.has(p.category) ||
      hasWholeWord(p.name, "staked") ||
      hasWholeWord(p.name, "staking")
    ) {
      aside(p, "staked_product");
    } else if (BRIDGE_CATEGORIES.has(p.category)) {
      aside(p, "bridge_product");
    } else if (hasWholeWord(p.name, "wrapped")) {
      aside(p, "wrapped_product");
    } else if (p.category === "CEX") {
      aside(p, "cex_exchange");
    } else if (EXCHANGE_PREFIXES.some((e) => p.name === e || p.name.startsWith(e + " "))) {
      aside(p, "exchange_product");
    } else if (tradingFamilies.has(familyKeyOf(p.name)) || tradingFamilies.has(slugBaseOf(p.slug))) {
      aside(p, "sibling_of_trading");
    } else if (hasVersionMarker(p.name) || /-v\d+$/.test(p.slug)) {
      aside(p, "versioned");
    } else if (p.tvl_usd < 5000000) {
      aside(p, "below_floor");
    } else {
      ranked.push(p);
    }
  }
  const byReason = {};
  for (const reason of setAside.values()) byReason[reason] = (byReason[reason] || 0) + 1;
  return {
    anchors,
    ranked,
    reconciliation: {
      total: protocols.length,
      trading_anchors: anchors.length,
      ranked: ranked.length,
      set_aside: setAside.size,
      set_aside_by_reason: byReason,
    },
  };
}

// --- the fit, mirroring main.ts fitModel -----------------------------------

const SHRINKAGE_K = 16;
const HUBER_C = 1.345;
const CARRY_FLOOR = Math.log10(0.75);
const CARRY_CAP = Math.log10(1.25);

function weightedLineFit(xs, ys, ws) {
  let sw = 0, sx = 0, sy = 0;
  for (let i = 0; i < xs.length; i++) {
    sw += ws[i];
    sx += ws[i] * xs[i];
    sy += ws[i] * ys[i];
  }
  const mx = sx / sw;
  const my = sy / sw;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += ws[i] * (xs[i] - mx) * (ys[i] - my);
    sxx += ws[i] * (xs[i] - mx) * (xs[i] - mx);
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  return { intercept: my - slope * mx, slope };
}
function huberLineFit(xs, ys) {
  let { intercept, slope } = weightedLineFit(xs, ys, xs.map(() => 1));
  for (let iter = 0; iter < 60; iter++) {
    const residuals = ys.map((y, i) => y - (intercept + slope * xs[i]));
    const centre = median(residuals);
    const mad = median(residuals.map((r) => Math.abs(r - centre)));
    const scale = 1.4826 * mad;
    if (scale === 0) break;
    const ws = residuals.map((r) => {
      const u = Math.abs(r - centre) / (HUBER_C * scale);
      return u <= 1 ? 1 : 1 / u;
    });
    const next = weightedLineFit(xs, ys, ws);
    const moved = Math.abs(next.intercept - intercept) + Math.abs(next.slope - slope);
    intercept = next.intercept;
    slope = next.slope;
    if (moved < 1e-12) break;
  }
  return { intercept, slope };
}
function throughOrigin(xs, ys) {
  let sxy = 0, sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += xs[i] * ys[i];
    sxx += xs[i] * xs[i];
  }
  return sxx === 0 ? 0 : sxy / sxx;
}
function fitModel(anchorRows, asOfDay) {
  const xs = anchorRows.map((p) => Math.log10(p.tvl_usd));
  const ys = anchorRows.map((p) => Math.log10(p.mcap_usd));
  const curve = huberLineFit(xs, ys);
  const afterCurve = anchorRows.map((p, i) => ys[i] - (curve.intercept + curve.slope * xs[i]));
  const offsetSums = new Map();
  anchorRows.forEach((p, i) => {
    const c = categoryOf(p);
    if (!offsetSums.has(c)) offsetSums.set(c, { n: 0, sum: 0 });
    const e = offsetSums.get(c);
    e.n += 1;
    e.sum += afterCurve[i];
  });
  const offsets = {};
  for (const [c, e] of offsetSums) offsets[c] = (e.n / (e.n + SHRINKAGE_K)) * (e.sum / e.n);
  const afterOffset = anchorRows.map((p, i) => afterCurve[i] - (offsets[categoryOf(p)] || 0));
  const gamma = throughOrigin(
    anchorRows.map((p) => (p.change_7d == null ? 0 : p.change_7d)),
    afterOffset
  );
  const carryOf = (p) =>
    p.change_7d == null ? 0 : clamp(gamma * p.change_7d, CARRY_FLOOR, CARRY_CAP);
  const afterCarry = anchorRows.map((p, i) => afterOffset[i] - carryOf(p));
  const dated = anchorRows
    .map((p, i) => ({ p, r: afterCarry[i] }))
    .filter(({ p }) => p.listed_at != null);
  const delta = throughOrigin(
    dated.map(({ p }) => Math.log10(1 + daysBetween(p.listed_at, asOfDay) / 30)),
    dated.map(({ r }) => r)
  );
  return { intercept: curve.intercept, slope: curve.slope, offsets, gamma, delta };
}

// --- rebuild, then prove it against board.json ------------------------------

const { anchors, ranked, reconciliation } = classifyUniverse(snapshot);
const fitRows = anchors.filter((p) => p.category !== "CEX");
const failures = [];
const check = (label, got, want) => {
  if (got !== want) failures.push(`${label}: rebuilt ${got}, board.json says ${want}`);
};
check("universe.total", reconciliation.total, board.universe.total);
check("universe.trading_anchors", reconciliation.trading_anchors, board.universe.trading_anchors);
check("universe.ranked", reconciliation.ranked, board.universe.ranked);
check("universe.set_aside", reconciliation.set_aside, board.universe.set_aside);
check("universe.fit_anchors", fitRows.length, board.universe.fit_anchors);
check(
  "universe.trading_excluded_from_fit",
  anchors.length - fitRows.length,
  board.universe.trading_excluded_from_fit
);
for (const [reason, n] of Object.entries(board.universe.set_aside_by_reason)) {
  check(`set_aside.${reason}`, reconciliation.set_aside_by_reason[reason] || 0, n);
}
const rankedSlugs = new Set(ranked.map((p) => p.slug));
for (const row of board.rows) {
  if (!rankedSlugs.has(row.slug)) failures.push(`board row ${row.slug} is not in the rebuilt ranked set`);
}
const refit = fitModel(fitRows, asOf);
const f6 = (x) => Number(x.toFixed(6));
const coef = board.model.coefficients;
check("coef.intercept", f6(refit.intercept), coef.intercept);
check("coef.slope", f6(refit.slope), coef.slope_log10_tvl);
check("coef.gamma", f6(refit.gamma), coef.growth_carry_gamma_per_pct);
check("coef.delta", f6(refit.delta), coef.seasoning_delta);
for (const [cat, off] of Object.entries(board.model.category_offsets_log10)) {
  check(`offset.${cat}`, f6(refit.offsets[cat] || 0), off);
}
if (failures.length > 0) {
  console.error("ANCHOR REBUILD DOES NOT MATCH board.json:");
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}

const fitSlugs = new Set(fitRows.map((p) => p.slug));
const list = anchors
  .map((p) => [p.name, categoryOf(p), Math.round(p.tvl_usd), Math.round(p.mcap_usd), fitSlugs.has(p.slug) ? 1 : 0])
  .sort((a, b) => b[3] - a[3]);
const payload = {
  as_of: asOf,
  note:
    "Trading anchors rebuilt from the snapshot by tools/build-anchors.mjs and verified there " +
    "against board.json (counts and a refit reproducing its coefficients). in_fit 0 = a CEX " +
    "anchor: counted as trading, kept out of the fit. Fields: name, category, tvl_usd, mcap_usd, in_fit.",
  anchors: list,
};
writeFileSync(outPath, "window.__ANCHORS__ = " + JSON.stringify(payload) + ";\n");
console.log(
  `anchors rebuilt and verified: ${anchors.length} trading (${fitRows.length} in fit), ` +
    `refit matches board.json coefficients at 6 decimals; wrote ${outPath}`
);
