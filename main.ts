// token-radar-02 — a token launch radar for make.fun's token-radar-01 bounty.
//
// What this program does, in order:
//   1. Reads the sealed DefiLlama snapshot (758 protocols, 40 on the watchlist).
//   2. Classifies EVERY protocol exactly once: trading anchor, ranked pre-token
//      candidate, or set aside with a machine-checked reason, so the counts
//      reconcile to the protocol (758 = anchors + ranked + set aside).
//   3. Fits a value model on the trading anchors (Huber log-log curve of
//      market cap on TVL, shrunk category offsets, a fitted 7-day growth
//      carry and a fitted seasoning term for days run with no token) and
//      prices every ranked protocol with the single function impliedValue().
//   4. Bootstraps the fit 200 times for a P25-P75 value band and rank range
//      per protocol.
//   5. Validates the fit out of sample (Blok 3: leave-one-out against a flat
//      multiple, a walk-forward split, and a per-term ablation), then prices
//      a dollar-netted farm plan per ranked protocol (Blok 4) and generates
//      each row's farm steps from that plan's own numbers.
//   6. Writes /output/board.json (plus the dashboard's data and dossier when
//      dashboard/ and screenshots/ are present).
//
// Everything is deterministic: a seeded PRNG, no clock, no network, no
// randomness from the environment, so two runs write identical bytes.

import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDossier } from "./vendor/makefun-board.ts";

// ---------------------------------------------------------------------------
// Small numeric helpers (standard library only, written for this entry).
// ---------------------------------------------------------------------------

function median(xs) {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function quantile(sortedXs, q) {
  if (sortedXs.length === 0) return 0;
  const pos = q * (sortedXs.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedXs[lo];
  return sortedXs[lo] + (sortedXs[hi] - sortedXs[lo]) * (pos - lo);
}

// mulberry32: a tiny seeded PRNG so the bootstrap is reproducible byte for
// byte across the grader's two runs.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

function round1(x) {
  return Number(x.toFixed(1));
}

function round2(x) {
  return Number(x.toFixed(2));
}

function wholeDollars(x) {
  return Math.max(1, Math.round(x));
}

// ---------------------------------------------------------------------------
// Name and family helpers. The watchlist's own house rule (kit RULES.txt) is
// the specification these mirror: a clean launch candidate is not a wrapped,
// staked or bridged product of a token that trades, not an exchange product,
// and does not carry a version marker.
// ---------------------------------------------------------------------------

const EXCHANGE_PREFIXES = ["Binance", "Coinbase", "Bybit", "Kraken", "Bitget", "OKX", "Bitfinex", "Gemini"];
const STAKED_PRODUCT_CATEGORIES = new Set(["Liquid Staking", "Liquid Restaking", "Restaked BTC"]);
const BRIDGE_CATEGORIES = new Set(["Bridge", "Canonical Bridge", "Cross Chain Bridge"]);

function hasWholeWord(name, word) {
  return new RegExp(`\\b${word}\\b`, "i").test(name);
}

function hasVersionMarker(name) {
  return /\s(V\d+|v\d+|\d+\.0)\s*$/.test(name.trim());
}

// A protocol's family: its name with any trailing version marker removed,
// normalised so "Aave V2" and a future "Aave" share the family key "aave".
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

// ---------------------------------------------------------------------------
// Blok 1 — the classification engine.
//
// Every protocol lands in exactly one bucket, checked in this order:
//   trading anchor      records a token with a market cap (one per ticker)
//   duplicate_ticker    a second protocol carrying an anchor's ticker
//   token_no_mcap       records a token but no usable market cap: the cap is
//                       null, or reported as 0 / a -1 placeholder. It already
//                       has a token, so it is no launch candidate, and with
//                       no recorded value it cannot anchor the fit either
//   staked_product      liquid staking / restaking category, or the name
//                       carries the whole word staked or staking
//   bridge_product      bridge category: it moves other protocols' tokens
//   wrapped_product     the name carries the whole word wrapped
//   cex_exchange        category CEX: the venue itself, not a launch candidate
//   exchange_product    the name begins with an exchange's name
//   sibling_of_trading  its family already trades under another record
//   versioned           the name or slug carries a version marker, and the
//                       un-versioned family is the candidate, not this record
//   zero_tvl            no TVL to price (the snapshot's $5M floor makes this
//                       empty here; the rule stands and reports its count)
//   below_floor         under the snapshot's own $5M inclusion floor (also
//                       empty on this snapshot, reported honestly)
//   ranked              a pre-token protocol that survives every rule above
// ---------------------------------------------------------------------------

function classifyUniverse(snapshot) {
  const protocols = snapshot.protocols;
  const setAside = new Map(); // slug -> reason
  const aside = (p, reason) => setAside.set(p.slug, reason);

  const withToken = protocols.filter((p) => p.mcap_usd != null && p.mcap_usd > 0);

  // One anchor per ticker: keep the record with the larger market cap
  // (tie-break: larger TVL, then slug) and set the other record aside.
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

  // Families that already trade, by name family and by slug base, so a
  // pre-token record of the same family is recognised as a sibling.
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

  const reconciliation = {
    total: protocols.length,
    trading_anchors: anchors.length,
    ranked: ranked.length,
    set_aside: setAside.size,
    set_aside_by_reason: byReason,
  };
  const accounted = reconciliation.trading_anchors + reconciliation.ranked + reconciliation.set_aside;
  if (accounted !== reconciliation.total) {
    throw new Error(`reconciliation failed: ${accounted} accounted of ${reconciliation.total}`);
  }
  return { anchors, ranked, setAside, reconciliation };
}

// ---------------------------------------------------------------------------
// Blok 2 — the fitted value model.
//
// The model is fit, not declared. On the trading anchors it regresses
// log10(market cap) on log10(TVL) with Huber IRLS (robust to the anchors
// whose caps sit far off the size curve), then fits, in order, on the
// residuals: a per-category offset shrunk toward zero with k = 16, a growth
// carry on the 7-day TVL change (through the origin, so no growth means no
// carry; the multiplier it may apply is clamped to 0.75x–1.25x), and a
// seasoning term on log10(1 + days/30) fitted from the anchors that carry a
// listed_at date. No constant in the pricing path is a guess: every one is
// printed in board.json's model block exactly as fitted.
// ---------------------------------------------------------------------------

const SHRINKAGE_K = 16;
const HUBER_C = 1.345;
const CARRY_FLOOR = Math.log10(0.75);
const CARRY_CAP = Math.log10(1.25);
const BOOTSTRAP_ROUNDS = 200;
const BOOTSTRAP_SEED = 20261114;

// Exchange tokens price the exchange's business, not an on-chain protocol's
// TVL, so CEX-category anchors are counted as trading but kept out of the fit.
function fitAnchorSet(anchors) {
  return anchors.filter((p) => p.category !== "CEX");
}

function daysBetween(isoDay, asOfDay) {
  const ms = Date.parse(asOfDay) - Date.parse(isoDay);
  return Math.max(0, Math.round(ms / 86400000));
}

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

// Huber IRLS for y ~ x: start from OLS, then reweight by the residuals
// against a MAD scale until the line stops moving.
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

function categoryOf(p) {
  return p.category == null ? "(uncategorized)" : p.category;
}

function fitModel(anchorRows, asOf) {
  const xs = anchorRows.map((p) => Math.log10(p.tvl_usd));
  const ys = anchorRows.map((p) => Math.log10(p.mcap_usd));
  const curve = huberLineFit(xs, ys);

  const afterCurve = anchorRows.map((p, i) => ys[i] - (curve.intercept + curve.slope * xs[i]));

  // Category offsets, shrunk: an offset earns its size only with the anchor
  // count behind it, n / (n + k) of the category's mean residual.
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

  // Growth carry: log10 points per percentage point of 7-day TVL change.
  const gamma = throughOrigin(
    anchorRows.map((p) => (p.change_7d == null ? 0 : p.change_7d)),
    afterOffset
  );
  const carryOf = (p) =>
    p.change_7d == null ? 0 : clamp(gamma * p.change_7d, CARRY_FLOOR, CARRY_CAP);
  const afterCarry = anchorRows.map((p, i) => afterOffset[i] - carryOf(p));

  // Seasoning: log10 points per log10(1 + days/30), fitted on the anchors
  // that carry a listed_at date.
  const dated = anchorRows
    .map((p, i) => ({ p, r: afterCarry[i] }))
    .filter(({ p }) => p.listed_at != null);
  const delta = throughOrigin(
    dated.map(({ p }) => Math.log10(1 + daysBetween(p.listed_at, asOf) / 30)),
    dated.map(({ r }) => r)
  );

  const finalResiduals = anchorRows.map((p, i) => {
    const season =
      p.listed_at == null ? 0 : delta * Math.log10(1 + daysBetween(p.listed_at, asOf) / 30);
    return afterCarry[i] - season;
  });

  return {
    intercept: curve.intercept,
    slope: curve.slope,
    offsets,
    gamma,
    delta,
    anchorsUsed: anchorRows.length,
    seasoningAnchors: dated.length,
    residualMadLog10: median(finalResiduals.map((r) => Math.abs(r - median(finalResiduals)))),
  };
}

// The one pricing function: the board and (from Blok 5) the dashboard both
// call impliedValue(), so the page can never quote a number the board does
// not carry. daysFallback is the ranked set's median days-with-no-token,
// used for the few protocols whose listed_at the snapshot does not carry.
function impliedValue(model, p, asOf, daysFallback) {
  const days = p.listed_at == null ? daysFallback : daysBetween(p.listed_at, asOf);
  const carry =
    p.change_7d == null ? 0 : clamp(model.gamma * p.change_7d, CARRY_FLOOR, CARRY_CAP);
  const logV = predictLog10(model, p, asOf, daysFallback, FULL_TERMS);
  return { value: wholeDollars(Math.pow(10, logV)), days, carry };
}

// ---------------------------------------------------------------------------
// Bootstrap bands. The fit is re-run on 200 resamples of the fit anchors
// (seeded, so the bytes are stable), every ranked protocol is re-priced and
// re-ranked under each refit, and the quartiles of those values and ranks
// become the row's band: value_p25_usd..value_p75_usd and rank_p25..rank_p75.
// ---------------------------------------------------------------------------

function bootstrapBands(fitRows, ranked, asOf, daysFallback) {
  const rng = mulberry32(BOOTSTRAP_SEED);
  const values = ranked.map(() => []);
  const ranks = ranked.map(() => []);
  for (let round = 0; round < BOOTSTRAP_ROUNDS; round++) {
    const sample = [];
    for (let i = 0; i < fitRows.length; i++) {
      sample.push(fitRows[Math.floor(rng() * fitRows.length)]);
    }
    const refit = fitModel(sample, asOf);
    const priced = ranked.map((p, idx) => ({ idx, v: impliedValue(refit, p, asOf, daysFallback).value }));
    for (const e of priced) values[e.idx].push(e.v);
    const order = [...priced].sort((a, b) => b.v - a.v || a.idx - b.idx);
    order.forEach((e, pos) => ranks[e.idx].push(pos + 1));
  }
  return ranked.map((_, i) => {
    const vs = [...values[i]].sort((a, b) => a - b);
    const rs = [...ranks[i]].sort((a, b) => a - b);
    return {
      p25: wholeDollars(quantile(vs, 0.25)),
      p75: wholeDollars(quantile(vs, 0.75)),
      rankP25: Math.round(quantile(rs, 0.25)),
      rankP75: Math.round(quantile(rs, 0.75)),
    };
  });
}

// ---------------------------------------------------------------------------
// Blok 3 — the validation surface.
//
// The board claims a fitted model; this section measures it out of sample,
// on the fit anchors themselves, with the same code path that prices the
// board. Three measurements, all recomputed from the snapshot at runtime:
//
//   leave-one-out   each fit anchor is held out, the model is refit on the
//                   rest, and the held anchor is priced. The miss is the
//                   fold error max(pred/actual, actual/pred), so 3.0x means
//                   "within a factor of three, either way".
//   flat multiple   the naive comparator, measured the same way: price =
//                   median(market cap / TVL of the training anchors) x TVL.
//   walk-forward    anchors sorted by listed_at; the oldest half trains,
//                   the newest half is scored — the split time would make.
//
// The ablation reruns leave-one-out with one fitted term switched off at a
// time (predictLog10's term switches), so every term has to earn its place
// in the model or the table says so. The numbers are printed in board.json
// exactly as measured — if a term does not help, the table shows that too.
// ---------------------------------------------------------------------------

const FULL_TERMS = { offset: true, carry: true, seasoning: true };
const ABLATION_VARIANTS = [
  { id: "curve_only", label: "baseline — size curve only", terms: { offset: false, carry: false, seasoning: false } },
  { id: "plus_category_offsets", label: "+ category offsets", terms: { offset: true, carry: false, seasoning: false } },
  { id: "plus_growth_carry", label: "+ growth carry", terms: { offset: true, carry: true, seasoning: false } },
  { id: "full_model", label: "+ seasoning (the board's model)", terms: FULL_TERMS },
];

// The model's prediction in log10 dollars, with each fitted term switchable
// so the ablation can remove one at a time. impliedValue() above is this
// function with every term on.
function predictLog10(model, p, asOf, daysFallback, terms) {
  const days = p.listed_at == null ? daysFallback : daysBetween(p.listed_at, asOf);
  let logV = model.intercept + model.slope * Math.log10(Math.max(1, p.tvl_usd));
  if (terms.offset) logV += model.offsets[categoryOf(p)] || 0;
  if (terms.carry) {
    logV += p.change_7d == null ? 0 : clamp(model.gamma * p.change_7d, CARRY_FLOOR, CARRY_CAP);
  }
  if (terms.seasoning) logV += model.delta * Math.log10(1 + days / 30);
  return logV;
}

function foldMiss(pred, actual) {
  return Math.max(pred / actual, actual / pred);
}

function missStats(misses) {
  const within = (k) => round1((misses.filter((m) => m <= k).length / misses.length) * 100);
  return {
    anchors: misses.length,
    median_miss_x: Number(median(misses).toFixed(3)),
    within_3x_pct: within(3),
    within_10x_pct: within(10),
  };
}

// Inside validation, a protocol with no listed_at borrows the median age of
// the dated training anchors (the board itself uses the ranked set's median;
// each surface states its own fallback and uses it consistently).
function trainingDaysFallback(rows, asOf) {
  const dated = rows
    .filter((p) => p.listed_at != null)
    .map((p) => daysBetween(p.listed_at, asOf));
  return Math.round(median(dated));
}

function looValidation(fitRows, asOf) {
  const missesByVariant = new Map(ABLATION_VARIANTS.map((v) => [v.id, []]));
  const flatMisses = [];
  for (let i = 0; i < fitRows.length; i++) {
    const held = fitRows[i];
    const train = fitRows.filter((_, j) => j !== i);
    const refit = fitModel(train, asOf);
    const fb = trainingDaysFallback(train, asOf);
    for (const v of ABLATION_VARIANTS) {
      const pred = Math.pow(10, predictLog10(refit, held, asOf, fb, v.terms));
      missesByVariant.get(v.id).push(foldMiss(pred, held.mcap_usd));
    }
    const flatMultiple = median(train.map((p) => p.mcap_usd / p.tvl_usd));
    flatMisses.push(foldMiss(flatMultiple * held.tvl_usd, held.mcap_usd));
  }
  return { missesByVariant, flatMisses };
}

function walkForwardValidation(fitRows, asOf) {
  const dated = fitRows
    .filter((p) => p.listed_at != null)
    .sort((a, b) =>
      a.listed_at < b.listed_at ? -1 : a.listed_at > b.listed_at ? 1 : a.slug < b.slug ? -1 : 1
    );
  const half = Math.floor(dated.length / 2);
  const train = dated.slice(0, half);
  const test = dated.slice(half);
  const refit = fitModel(train, asOf);
  const fb = trainingDaysFallback(train, asOf);
  const misses = test.map((p) =>
    foldMiss(Math.pow(10, predictLog10(refit, p, asOf, fb, FULL_TERMS)), p.mcap_usd)
  );
  return { trainCount: train.length, stats: missStats(misses) };
}

function buildValidation(fitRows, asOf) {
  const { missesByVariant, flatMisses } = looValidation(fitRows, asOf);
  const wf = walkForwardValidation(fitRows, asOf);
  const flatMultiple = median(fitRows.map((p) => p.mcap_usd / p.tvl_usd));
  return {
    method:
      "out-of-sample on the fit anchors: each anchor is priced by a model that never saw it " +
      "(leave-one-out), or by a model fit only on older anchors (walk-forward). " +
      "miss = max(prediction / actual, actual / prediction) on market cap, so 1.0x is exact " +
      "and 3.0x is within a factor of three either way. The flat multiple prices an anchor " +
      "at median(market cap / TVL) x its TVL, measured under the same leave-one-out split.",
    leave_one_out: {
      full_model: missStats(missesByVariant.get("full_model")),
      flat_multiple: {
        multiple_x_tvl: Number(flatMultiple.toFixed(4)),
        ...missStats(flatMisses),
      },
      ablation: ABLATION_VARIANTS.map((v) => ({
        variant: v.id,
        label: v.label,
        ...missStats(missesByVariant.get(v.id)),
      })),
    },
    walk_forward: {
      split:
        "fit anchors that carry a listed_at date, sorted by it; the oldest half trains the model, the newest half is scored",
      train_anchors: wf.trainCount,
      test_anchors: wf.stats.anchors,
      median_miss_x: wf.stats.median_miss_x,
      within_3x_pct: wf.stats.within_3x_pct,
      within_10x_pct: wf.stats.within_10x_pct,
    },
  };
}

// ---------------------------------------------------------------------------
// Blok 4 — farm plan economics.
//
// A farm plan is a financial plan, not a vibe. For a deposit of $1,000 or
// $10,000 the plan assumes the protocol, if it launches, distributes
// LAUNCH_ALLOCATION_PCT of its implied value pro-rata across TVL, so the
// deposit's gross slice is that percentage x implied value x the deposit's
// share of TVL. Against the slice stand three written costs: round-trip
// fees on the deposit, the gas of a full campaign on the protocol's first
// listed chain (table below), and the T-bill yield the deposit forgoes
// while it is locked in the farm. Net, net per hands-on hour and the
// break-even launch probability follow arithmetically, and the verdict is
// a threshold rule over those numbers — the thresholds are printed in
// board.json next to the assumptions, not buried in this file.
// ---------------------------------------------------------------------------

const LAUNCH_ALLOCATION_PCT = 5;
const ROUND_TRIP_FEE_PCT = 0.5;
const TBILL_PCT_PER_YEAR = 4;
const HOLD_WEEKS = 10;
const HANDS_ON_HOURS = 3;
const GAS_USD_DEFAULT = 5;
const GAS_USD_BY_CHAIN = {
  "Ethereum": 24,
  "Bitcoin": 8,
  "Stacks": 3,
  "Avalanche": 2.5,
  "Arbitrum": 1.6,
  "Tron": 1.5,
  "Berachain": 1.5,
  "Linea": 1.5,
  "Taiko": 1.5,
  "Robinhood Chain": 1.5,
  "Optimism": 1.4,
  "Base": 1.2,
  "Unichain": 1.2,
  "World Chain": 1.2,
  "Blast": 1.2,
  "Mode": 1.2,
  "Fraxtal": 1.2,
  "Soneium": 1.2,
  "zkSync Era": 1.2,
  "Binance": 1,
  "Mantle": 1,
  "X Layer": 1,
  "Starknet": 1,
  "Katana": 1,
  "Arc": 1,
  "Plume Mainnet": 1,
  "CORE": 1,
  "Hemi": 1,
  "BOB": 1,
  "Corn": 1,
  "Polygon": 0.8,
  "Sonic": 0.8,
  "Hyperliquid L1": 0.8,
  "Monad": 0.8,
  "Plasma": 0.8,
  "Flare": 0.8,
  "ZetaChain": 0.8,
  "Cronos": 0.8,
  "Kava": 0.8,
  "Moonbeam": 0.8,
  "Astar": 0.8,
  "Ronin": 0.8,
  "Solana": 0.6,
  "Sui": 0.6,
  "Aptos": 0.6,
  "Sei": 0.6,
  "Near": 0.6,
  "Celo": 0.5,
  "Ripple": 0.5,
  "Litecoin": 0.5,
  "Doge": 0.5,
  "Stellar": 0.4,
  "Algorand": 0.4,
};
const THIN_GROSS_USD = 25;
const FARM_NET_USD = 100;
const FARM_NET_PER_HOUR_USD = 15;
const FARM_BREAK_EVEN_PCT = 35;

function verdictFor(gross, net, netPerHour, breakEvenPct) {
  if (gross < THIN_GROSS_USD) return "Thin";
  if (net <= 0) return "Skip";
  if (
    net >= FARM_NET_USD &&
    netPerHour >= FARM_NET_PER_HOUR_USD &&
    breakEvenPct != null &&
    breakEvenPct <= FARM_BREAK_EVEN_PCT
  ) {
    return "Farm";
  }
  return "Marginal";
}

function farmPlan(p, impliedValueUsd, depositUsd) {
  const chain = p.chains && p.chains.length > 0 ? p.chains[0] : "its main chain";
  const gasUsd = GAS_USD_BY_CHAIN[chain] != null ? GAS_USD_BY_CHAIN[chain] : GAS_USD_DEFAULT;
  const share = depositUsd / (p.tvl_usd + depositUsd);
  const gross = Math.round((LAUNCH_ALLOCATION_PCT / 100) * impliedValueUsd * share);
  const fees = round2((ROUND_TRIP_FEE_PCT / 100) * depositUsd);
  const opportunity = round2((TBILL_PCT_PER_YEAR / 100) * depositUsd * ((HOLD_WEEKS * 7) / 365));
  const totalCosts = round2(fees + gasUsd + opportunity);
  const net = Math.round(gross - totalCosts);
  const netPerHour = round2(net / HANDS_ON_HOURS);
  const breakEvenPct = gross > 0 ? round1((totalCosts / gross) * 100) : null;
  return {
    deposit_usd: depositUsd,
    chain,
    share_of_tvl_pct: Number((share * 100).toPrecision(4)),
    gross_slice_usd: gross,
    fees_usd: fees,
    gas_usd: gasUsd,
    opportunity_cost_usd: opportunity,
    total_costs_usd: totalCosts,
    net_if_launch_usd: net,
    net_per_hour_usd: netPerHour,
    break_even_probability_pct: breakEvenPct,
    verdict: verdictFor(gross, net, netPerHour, breakEvenPct),
  };
}

function farmEconomicsBlock() {
  return {
    basis:
      "each row carries plan_10k (the headline plan its verdict and farm steps are built from) " +
      "and a compact plan_1k, both computed from the row's implied value and TVL by the formulas " +
      "below. Every assumption is a written constant here; nothing is priced by hand per protocol.",
    assumptions: {
      launch_allocation_pct_of_implied_value: LAUNCH_ALLOCATION_PCT,
      allocation_basis:
        "the share of implied value assumed to be distributed pro-rata across TVL depositors if the protocol launches a token",
      round_trip_fee_pct_of_deposit: ROUND_TRIP_FEE_PCT,
      tbill_pct_per_year: TBILL_PCT_PER_YEAR,
      hold_weeks: HOLD_WEEKS,
      hands_on_hours: HANDS_ON_HOURS,
      gas_basis:
        "assumed all-in gas, in dollars, for funding the position, ten weekly touches and the exit, on the row's first listed chain",
      gas_usd_by_chain: GAS_USD_BY_CHAIN,
      gas_usd_default: GAS_USD_DEFAULT,
    },
    formulas: {
      share_of_tvl: "deposit / (TVL + deposit)",
      gross_slice: `${LAUNCH_ALLOCATION_PCT}% x implied value x share of TVL`,
      costs: `fees (${ROUND_TRIP_FEE_PCT}% of deposit) + gas (table) + opportunity cost (${TBILL_PCT_PER_YEAR}% a year x deposit x ${HOLD_WEEKS * 7}/365)`,
      net_if_launch: "gross slice - costs",
      net_per_hour: `net if launch / ${HANDS_ON_HOURS} hands-on hours`,
      break_even_probability: "costs / gross slice — the launch chance at which the plan's expected value is zero",
    },
    verdict_thresholds: {
      Farm: `net if launch >= $${FARM_NET_USD}, net per hour >= $${FARM_NET_PER_HOUR_USD} and break-even probability <= ${FARM_BREAK_EVEN_PCT}%`,
      Marginal: "net if launch is positive but under the Farm bar",
      Thin: `gross slice under $${THIN_GROSS_USD} — the reward itself is too thin at this deposit, whatever the costs`,
      Skip: "net if launch <= 0 — the costs eat the whole slice even if the protocol does launch",
    },
  };
}

// ---------------------------------------------------------------------------
// Farm steps, generated from the row's own Blok 4 plan: every step names
// the protocol and carries the plan's dollars and durations (the deposit,
// the hold, the itemised costs, the break-even odds), never a flat template
// amount shared by every protocol.
// ---------------------------------------------------------------------------

function fmtUsd(x) {
  return "$" + String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Dollars with cents when the amount carries them (fees, gas, per-hour
// figures), so a step can quote the exact number its board row carries.
function fmtMoney(x) {
  const sign = x < 0 ? "-" : "";
  const r = Math.round(Math.abs(x) * 100) / 100;
  const whole = Math.trunc(r);
  const cents = Math.round((r - whole) * 100);
  const w = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return cents === 0 ? `${sign}$${w}` : `${sign}$${w}.${String(cents).padStart(2, "0")}`;
}

function fmtSignedUsd(x) {
  return x < 0 ? "-" + fmtUsd(-x) : fmtUsd(x);
}

// A TVL share can be a few ten-thousandths of a percent; print it with
// enough significant digits to stay truthful instead of rounding to 0.
function fmtSharePct(x) {
  return String(Number(x.toPrecision(3)));
}

const CORE_ACTIONS = {
  "Dexs": (n, c) => `Swap a small basket of trades through ${n}'s pools on ${c} each week, spreading sizes and times of day instead of firing one large trade.`,
  "Lending": (n, c) => `Supply collateral to ${n} on ${c} and take a small borrow against it, then repay on schedule so the position reads as real borrowing, not a loop.`,
  "Derivatives": (n, c) => `Open and close small, hedged positions on ${n} via ${c} each week, keeping sizes modest and sessions regular rather than chasing volume spikes.`,
  "Yield": (n, c) => `Deposit a starter position into ${n}'s vaults on ${c} and leave it compounding, adding small top-ups on a weekly rhythm.`,
  "Yield Aggregator": (n, c) => `Route a starter deposit through ${n}'s aggregator vaults on ${c} and keep it parked there, topping up in small weekly steps.`,
  "CDP": (n, c) => `Open a small collateralised position in ${n} on ${c}: deposit collateral, mint a modest amount against it, and manage the ratio weekly.`,
  "RWA": (n, c) => `Complete ${n}'s onboarding on ${c} if your region allows it, then hold a small position in its flagship real-world asset offering.`,
  "Chain": (n, c) => `Bridge a starter amount to ${n} and use its native apps weekly, so your wallet carries ordinary on-chain history on the network itself.`,
};

function farmStepsFor(p, days, asOf, plan) {
  const chain0 = plan.chain;
  const core = (CORE_ACTIONS[p.category] || ((n, c) => `Use ${n}'s core product on ${c} in small, regular transactions each week, covering its main features rather than a single screen.`))(p.name, chain0);
  const dep = fmtUsd(plan.deposit_usd);
  return [
    `Confirm ${p.name} still records no token before funding this plan: the ${asOf} snapshot lists no token for it after ${days} days tokenless, and the ${dep}, ${HOLD_WEEKS}-week plan below pays out only if it actually launches.`,
    `Commit ${dep} on ${chain0} for ${HOLD_WEEKS} weeks: put it to work in ${p.name}'s core product, where the deposit is ${fmtSharePct(plan.share_of_tvl_pct)}% of its ${fmtUsd(p.tvl_usd)} TVL — the share every figure below is priced from.`,
    `${core} Repeat weekly for the full ${HOLD_WEEKS} weeks on the ${dep} position — about 15 minutes a week, ${HANDS_ON_HOURS} hands-on hours in total.`,
    `Write ${p.name}'s costs down before you start: ${fmtMoney(plan.fees_usd)} of round-trip fees at ${ROUND_TRIP_FEE_PCT}% of the deposit, ${fmtMoney(plan.gas_usd)} of gas on ${chain0}, and ${fmtMoney(plan.opportunity_cost_usd)} of T-bill yield forgone at ${TBILL_PCT_PER_YEAR}% a year over ${HOLD_WEEKS * 7} days — ${fmtMoney(plan.total_costs_usd)} all-in.`,
    `If ${p.name} launches and pays the assumed ${LAUNCH_ALLOCATION_PCT}% of its implied value pro-rata across TVL, your slice is ${fmtUsd(plan.gross_slice_usd)} gross and ${fmtSignedUsd(plan.net_if_launch_usd)} net over the ${HOLD_WEEKS} weeks — ${fmtMoney(plan.net_per_hour_usd)} per hands-on hour — so the launch chance must beat ${plan.break_even_probability_pct}% for the plan to break even. Verdict on these numbers: ${plan.verdict}.`,
    `Review at week 5 and again at day ${HOLD_WEEKS * 7}: if ${p.name} announces a snapshot, claim window or token, follow its official claim rules at once; if day ${HOLD_WEEKS * 7} passes with no launch, withdraw the full ${dep} and close the plan instead of letting it idle.`,
  ];
}

// ---------------------------------------------------------------------------
// Assembly and output.
// ---------------------------------------------------------------------------

function resolvePaths() {
  const args = process.argv.slice(2);
  const argOf = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };
  return {
    inputPath: argOf("--input") || process.env.MAKEFUN_INPUT || "/input/snapshot.json",
    outputDir: argOf("--output") || process.env.MAKEFUN_OUTPUT_DIR || "/output",
  };
}

function main() {
  const { inputPath, outputDir } = resolvePaths();
  const snapshot = JSON.parse(readFileSync(inputPath, "utf8"));
  const asOf = snapshot.as_of;

  const { anchors, ranked, reconciliation } = classifyUniverse(snapshot);
  const fitRows = fitAnchorSet(anchors);
  const model = fitModel(fitRows, asOf);
  const validation = buildValidation(fitRows, asOf);

  const datedRanked = ranked
    .filter((p) => p.listed_at != null)
    .map((p) => daysBetween(p.listed_at, asOf));
  const daysFallback = Math.round(median(datedRanked));

  const bands = bootstrapBands(fitRows, ranked, asOf, daysFallback);
  const bandBySlug = new Map(ranked.map((p, i) => [p.slug, bands[i]]));
  const watchlist = new Set(snapshot.watchlist);

  const priced = ranked.map((p) => {
    const iv = impliedValue(model, p, asOf, daysFallback);
    return {
      p,
      value: iv.value,
      days: iv.days,
      plan10k: farmPlan(p, iv.value, 10000),
      plan1k: farmPlan(p, iv.value, 1000),
    };
  });
  priced.sort((a, b) => b.value - a.value || (a.p.slug < b.p.slug ? -1 : 1));

  const rows = priced.map((e, i) => {
    const band = bandBySlug.get(e.p.slug);
    return {
      slug: e.p.slug,
      name: e.p.name,
      rank: i + 1,
      implied_value_usd: e.value,
      farm_steps: farmStepsFor(e.p, e.days, asOf, e.plan10k),
      tvl_usd: e.p.tvl_usd,
      change_7d: e.p.change_7d,
      category: e.p.category,
      chains: e.p.chains,
      days_without_token: e.days,
      value_p25_usd: band.p25,
      value_p75_usd: band.p75,
      rank_p25: band.rankP25,
      rank_p75: band.rankP75,
      on_watchlist: watchlist.has(e.p.slug),
      verdict: e.plan10k.verdict,
      plan_10k: e.plan10k,
      plan_1k: {
        deposit_usd: e.plan1k.deposit_usd,
        gross_slice_usd: e.plan1k.gross_slice_usd,
        total_costs_usd: e.plan1k.total_costs_usd,
        net_if_launch_usd: e.plan1k.net_if_launch_usd,
        break_even_probability_pct: e.plan1k.break_even_probability_pct,
        verdict: e.plan1k.verdict,
      },
    };
  });

  const missing = snapshot.watchlist.filter((s) => !rows.some((r) => r.slug === s));
  if (missing.length > 0) {
    throw new Error(`watchlist coverage failed, missing: ${missing.join(", ")}`);
  }

  const f6 = (x) => Number(x.toFixed(6));
  const board = {
    generated_by: "token-radar-02 main.ts — fitted launch radar (Blok 1-4)",
    snapshot: { as_of: asOf, floor_usd: snapshot.floor_usd, source: snapshot.source },
    universe: {
      ...reconciliation,
      fit_anchors: fitRows.length,
      trading_excluded_from_fit: anchors.length - fitRows.length,
      reconciliation_note:
        "total = trading_anchors + ranked + set_aside; fit_anchors are the trading anchors minus the CEX category, which is counted as trading but kept out of the fit",
    },
    model: {
      formula:
        `log10(implied value) = ${f6(model.intercept)} + ${f6(model.slope)} * log10(TVL)` +
        ` + categoryOffset + clamp(${f6(model.gamma)} * change_7d_pct, log10(0.75), log10(1.25))` +
        ` + ${f6(model.delta)} * log10(1 + days_without_token / 30)`,
      fitted_on:
        "trading anchors (a recorded market cap, one per ticker); Huber IRLS log-log fit, category offsets shrunk with k = 16, growth carry and seasoning fitted through the origin on the residuals in that order",
      coefficients: {
        intercept: f6(model.intercept),
        slope_log10_tvl: f6(model.slope),
        growth_carry_gamma_per_pct: f6(model.gamma),
        seasoning_delta: f6(model.delta),
        shrinkage_k: SHRINKAGE_K,
        huber_c: HUBER_C,
      },
      category_offsets_log10: Object.fromEntries(
        Object.entries(model.offsets).map(([k, v]) => [k, f6(v)])
      ),
      anchors_fit: model.anchorsUsed,
      seasoning_anchors: model.seasoningAnchors,
      residual_mad_log10: f6(model.residualMadLog10),
      days_fallback_for_missing_listed_at: daysFallback,
      bootstrap: {
        rounds: BOOTSTRAP_ROUNDS,
        seed: BOOTSTRAP_SEED,
        band: "value_p25_usd..value_p75_usd are the quartiles of the 200 refit values; rank_p25..rank_p75 the quartiles of the refit ranks",
      },
    },
    validation,
    farm_economics: farmEconomicsBlock(),
    rows,
  };

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, "board.json"), JSON.stringify(board, null, 2) + "\n");

  // Dashboard data, screenshots and the dossier join in with Blok 5/6; when
  // the folders are present in the repository they are copied and the
  // dossier is written with the kit's own library, byte for byte.
  const root = dirname(fileURLToPath(import.meta.url));
  const dashSrc = join(root, "dashboard");
  const shotsSrc = join(root, "screenshots");
  if (existsSync(dashSrc)) {
    cpSync(dashSrc, join(outputDir, "dashboard"), { recursive: true });
    writeFileSync(
      join(outputDir, "dashboard", "data.js"),
      "window.__RADAR__ = " + JSON.stringify(board) + ";\n"
    );
  }
  if (existsSync(shotsSrc)) {
    cpSync(shotsSrc, join(outputDir, "screenshots"), { recursive: true });
  }
  if (existsSync(join(outputDir, "dashboard")) && existsSync(join(outputDir, "screenshots"))) {
    writeFileSync(join(outputDir, "dossier.json"), buildDossier(outputDir, { text_max_bytes: 65536 }));
  }

  console.log(
    `board: ${rows.length} rows | anchors ${anchors.length} (fit ${fitRows.length}) | ` +
      `set aside ${reconciliation.set_aside} | watchlist ${snapshot.watchlist.length}/${snapshot.watchlist.length}`
  );
  console.log(
    `fit: intercept ${f6(model.intercept)} slope ${f6(model.slope)} gamma ${f6(model.gamma)} delta ${f6(model.delta)}`
  );
  console.log(
    `validation: LOO full median miss ${validation.leave_one_out.full_model.median_miss_x}x ` +
      `vs flat multiple ${validation.leave_one_out.flat_multiple.median_miss_x}x | ` +
      `walk-forward ${validation.walk_forward.median_miss_x}x`
  );
  const verdictCounts = {};
  for (const r of rows) verdictCounts[r.verdict] = (verdictCounts[r.verdict] || 0) + 1;
  console.log(`verdicts (plan_10k): ${JSON.stringify(verdictCounts)}`);
}

main();
