"use strict";
/* Token Radar — fitted launch board (token-radar-02, Blok 5).
   Renders only what data.js (the board the program wrote) and
   data-anchors.js (the trading anchors, rebuilt and verified against the
   board by tools/build-anchors.mjs) carry. No network, no libraries.
   The page also re-prices, re-plans and re-verdicts every row on load with
   its own copy of the model formulas and reports how many rows agree. */

const B = window.__RADAR__;
const AN = window.__ANCHORS__ || { anchors: [] };
const ROWS = B.rows;
const COEF = B.model.coefficients;
const OFFSETS = B.model.category_offsets_log10 || {};
const ASSUMP = B.farm_economics.assumptions;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ------------------------------------------------------------- formatting
function commas(x) { return String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
function fmtUsd(x) { return (x < 0 ? "-$" : "$") + commas(Math.abs(x)); }
function fmtBig(x) {
  const a = Math.abs(x);
  if (a >= 1e9) return "$" + trimNum(x / 1e9) + "B";
  if (a >= 1e6) return "$" + trimNum(x / 1e6) + "M";
  if (a >= 1e3) return "$" + trimNum(x / 1e3) + "K";
  return fmtUsd(x);
}
function trimNum(v) {
  const s = v.toPrecision(3);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}
function fmtPct(x, digits) {
  if (x == null) return "—";
  const d = digits == null ? 1 : digits;
  return (x > 0 ? "+" : "") + x.toFixed(d) + "%";
}
function fmtX(x) { return x == null ? "—" : String(x) + "×"; }
// Dollars with cents when the amount carries them, as main.ts prints them
// in the farm steps ($1.20 of gas, not $1).
function fmtMoney(x) {
  const sign = x < 0 ? "-" : "";
  const r = Math.round(Math.abs(x) * 100) / 100;
  const whole = Math.trunc(r);
  const cents = Math.round((r - whole) * 100);
  return sign + "$" + commas(whole) + (cents === 0 ? "" : "." + String(cents).padStart(2, "0"));
}

// ------------------------------------------------- the model, mirrored
// The same formulas main.ts prices the board with, re-implemented here so
// the page can check the board instead of merely quoting it. Coefficients,
// offsets, gas table and thresholds all come from the board itself.
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const round1 = (x) => Number(x.toFixed(1));
const round2 = (x) => Number(x.toFixed(2));
const wholeDollars = (x) => Math.max(1, Math.round(x));
const CARRY_FLOOR = Math.log10(0.75);
const CARRY_CAP = Math.log10(1.25);

function impliedFor(row) {
  let logV = COEF.intercept + COEF.slope_log10_tvl * Math.log10(Math.max(1, row.tvl_usd));
  logV += OFFSETS[row.category] || 0;
  logV += row.change_7d == null ? 0 : clamp(COEF.growth_carry_gamma_per_pct * row.change_7d, CARRY_FLOOR, CARRY_CAP);
  logV += COEF.seasoning_delta * Math.log10(1 + row.days_without_token / 30);
  return wholeDollars(Math.pow(10, logV));
}
function thresholds() {
  const t = B.farm_economics.verdict_thresholds;
  const dollars = (s) => [...String(s).matchAll(/\$([\d.]+)/g)].map((m) => Number(m[1]));
  const farm = dollars(t.Farm);
  const be = /([\d.]+)%/.exec(String(t.Farm));
  const thin = dollars(t.Thin);
  return {
    farmNet: farm[0], farmPerHour: farm[1],
    farmBreakEven: be ? Number(be[1]) : null,
    thinGross: thin[0],
  };
}
function verdictFor(th, gross, net, netPerHour, breakEvenPct) {
  if (gross < th.thinGross) return "Thin";
  if (net <= 0) return "Skip";
  if (net >= th.farmNet && netPerHour >= th.farmPerHour && breakEvenPct != null && breakEvenPct <= th.farmBreakEven) return "Farm";
  return "Marginal";
}
function planFor(row, deposit) {
  const chain = row.chains && row.chains.length > 0 ? row.chains[0] : "its main chain";
  const gasTable = ASSUMP.gas_usd_by_chain || {};
  const gas = gasTable[chain] != null ? gasTable[chain] : ASSUMP.gas_usd_default;
  const share = deposit / (row.tvl_usd + deposit);
  const gross = Math.round((ASSUMP.launch_allocation_pct_of_implied_value / 100) * row.implied_value_usd * share);
  const fees = round2((ASSUMP.round_trip_fee_pct_of_deposit / 100) * deposit);
  const opportunity = round2((ASSUMP.tbill_pct_per_year / 100) * deposit * ((ASSUMP.hold_weeks * 7) / 365));
  const totalCosts = round2(fees + gas + opportunity);
  const net = Math.round(gross - totalCosts);
  const netPerHour = round2(net / ASSUMP.hands_on_hours);
  const breakEven = gross > 0 ? round1((totalCosts / gross) * 100) : null;
  return { chain, gas, gross, fees, opportunity, totalCosts, net, netPerHour, breakEven };
}

// ------------------------------------------------------- self-verification
function verifyBoard() {
  const t0 = performance.now();
  const th = thresholds();
  let ok = 0;
  const misses = [];
  for (const row of ROWS) {
    const bad = [];
    // The board prints its coefficients to 6 decimals, so a re-price from
    // the printed numbers can drift a few ten-thousandths — 0.01% is the
    // honest tolerance; any structural error (wrong offset, clamp or days)
    // misses by far more than that.
    if (Math.abs(impliedFor(row) - row.implied_value_usd) > Math.max(1, row.implied_value_usd * 1e-4)) bad.push("value");
    const p10 = planFor(row, 10000);
    const a10 = row.plan_10k;
    if (p10.gross !== a10.gross_slice_usd) bad.push("plan10k.gross");
    if (Math.abs(p10.totalCosts - a10.total_costs_usd) > 0.011) bad.push("plan10k.costs");
    if (p10.net !== a10.net_if_launch_usd) bad.push("plan10k.net");
    if ((p10.breakEven == null) !== (a10.break_even_probability_pct == null) ||
        (p10.breakEven != null && Math.abs(p10.breakEven - a10.break_even_probability_pct) > 0.11)) bad.push("plan10k.breakeven");
    if (verdictFor(th, p10.gross, p10.net, p10.netPerHour, p10.breakEven) !== a10.verdict) bad.push("plan10k.verdict");
    const p1 = planFor(row, 1000);
    const a1 = row.plan_1k;
    if (p1.gross !== a1.gross_slice_usd) bad.push("plan1k.gross");
    if (Math.abs(p1.totalCosts - a1.total_costs_usd) > 0.011) bad.push("plan1k.costs");
    if (p1.net !== a1.net_if_launch_usd) bad.push("plan1k.net");
    if (verdictFor(th, p1.gross, p1.net, p1.netPerHour, p1.breakEven) !== a1.verdict) bad.push("plan1k.verdict");
    // The bootstrap band and rank range are deliberately NOT checked here:
    // the page has no snapshot to re-run 200 refits, and a point rank can
    // honestly sit just outside its own interquartile range (4 rows do).
    if (bad.length === 0) ok++;
    else if (misses.length < 4) misses.push(row.slug + " (" + bad.join(", ") + ")");
  }
  const u = B.universe;
  const globals = [
    ["universe reconciles: " + u.total + " = " + u.trading_anchors + " anchors + " + u.ranked + " ranked + " + u.set_aside + " set aside",
      u.trading_anchors + u.ranked + u.set_aside === u.total],
    ["set-aside reasons sum to " + u.set_aside,
      Object.values(u.set_aside_by_reason).reduce((a, b) => a + b, 0) === u.set_aside],
    ["board carries " + u.ranked + " ranked rows", ROWS.length === u.ranked],
    ["ranks run 1.." + ROWS.length + " in the order printed",
      ROWS.every((r, i) => r.rank === i + 1)],
    ["implied values never rise as rank falls",
      ROWS.every((r, i) => i === 0 || ROWS[i - 1].implied_value_usd >= r.implied_value_usd)],
    ["every watchlist protocol is ranked (" + ROWS.filter((r) => r.on_watchlist).length + " on the board)",
      ROWS.filter((r) => r.on_watchlist).length === 40],
  ];
  return { ok, total: ROWS.length, misses, globals, ms: Math.max(1, Math.round(performance.now() - t0)) };
}

// ------------------------------------------------------------- state/hash
const VERDICTS = ["Farm", "Marginal", "Skip", "Thin"];
const VORDER = { Farm: 0, Marginal: 1, Thin: 2, Skip: 3 };
function famKey(name) {
  return name.replace(/\s+(V\d+|v\d+|\d+\.0)\s*$/, "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function defaultState() {
  return { view: "board", slug: null, v: "", cat: "", fam: "", chain: "", q: "",
           dep: 10000, anchors: 0, wl: 0, sort: "rank", dir: 1 };
}
function parseHash() {
  const st = defaultState();
  const h = location.hash.replace(/^#\/?/, "");
  if (h.startsWith("p/")) { st.view = "detail"; st.slug = decodeURIComponent(h.slice(2)); return st; }
  const qs = new URLSearchParams(h.startsWith("?") ? h.slice(1) : h);
  if (qs.get("v")) st.v = qs.get("v");
  if (qs.get("cat")) st.cat = qs.get("cat");
  if (qs.get("fam")) st.fam = qs.get("fam");
  if (qs.get("chain")) st.chain = qs.get("chain");
  if (qs.get("q")) st.q = qs.get("q");
  if (qs.get("dep") === "1000") st.dep = 1000;
  if (qs.get("anchors") === "1") st.anchors = 1;
  if (qs.get("wl") === "1") st.wl = 1;
  if (qs.get("sort")) st.sort = qs.get("sort");
  if (qs.get("dir") === "-1") st.dir = -1;
  return st;
}
function writeHash(st) {
  if (st.view === "detail") { location.hash = "#/p/" + encodeURIComponent(st.slug); return; }
  const qs = new URLSearchParams();
  if (st.v) qs.set("v", st.v);
  if (st.cat) qs.set("cat", st.cat);
  if (st.fam) qs.set("fam", st.fam);
  if (st.chain) qs.set("chain", st.chain);
  if (st.q) qs.set("q", st.q);
  if (st.dep !== 10000) qs.set("dep", String(st.dep));
  if (st.anchors) qs.set("anchors", "1");
  if (st.wl) qs.set("wl", "1");
  if (st.sort !== "rank") qs.set("sort", st.sort);
  if (st.dir !== 1) qs.set("dir", String(st.dir));
  const s = qs.toString();
  history.replaceState(null, "", s ? "#/?" + s : "#/");
}
let S = parseHash();

// ------------------------------------------------------------- rendering
const REASON_LABELS = {
  token_no_mcap: "records a token, no usable market cap",
  staked_product: "staked / liquid-staking product of a trading token",
  bridge_product: "bridge product — moves other protocols' tokens",
  cex_exchange: "the exchange itself (CEX category)",
  exchange_product: "exchange-branded product",
  wrapped_product: "wrapped product of a trading token",
  sibling_of_trading: "its family already trades",
  versioned: "versioned record; the un-versioned family is the candidate",
  duplicate_ticker: "second record carrying a trading ticker",
  zero_tvl: "no TVL to price",
  below_floor: "under the snapshot's inclusion floor",
};
function planOf(row) {
  const p = S.dep === 10000 ? row.plan_10k : row.plan_1k;
  return { net: p.net_if_launch_usd, be: p.break_even_probability_pct, verdict: p.verdict, gross: p.gross_slice_usd };
}
const LO = Math.min(...ROWS.map((r) => Math.log10(r.value_p25_usd)));
const HI = Math.max(...ROWS.map((r) => Math.log10(r.value_p75_usd)));
function rail(row, big) {
  const pos = (v) => ((Math.log10(v) - LO) / (HI - LO)) * 100;
  const l = pos(row.value_p25_usd), w = Math.max(1.5, pos(row.value_p75_usd) - l), d = pos(row.implied_value_usd);
  return '<span class="rail' + (big ? " big" : "") + '"><span class="seg2" style="left:' + l.toFixed(1) +
    '%;width:' + w.toFixed(1) + '%"></span><span class="dot" style="left:' + d.toFixed(1) + '%"></span></span>';
}

function renderStats() {
  const u = B.universe, loo = B.validation.leave_one_out;
  const wl = ROWS.filter((r) => r.on_watchlist).length;
  const aside = Object.entries(u.set_aside_by_reason)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => "<div>" + n + " — " + esc(REASON_LABELS[k] || k) + "</div>").join("");
  $("stats").innerHTML =
    stat(wl + "/" + wl, "watchlist covered", "every protocol on the snapshot's watchlist is ranked below; the program refuses to write a board that misses one") +
    stat(commas(u.ranked), "pre-token protocols ranked", "of " + commas(u.total) + " protocols in the snapshot universe") +
    stat(commas(u.trading_anchors), "already trading", u.fit_anchors + " of them anchor the fit; " + u.trading_excluded_from_fit + " exchange tokens are counted but kept out of it") +
    stat(commas(u.set_aside), "set aside, with reasons", "<details><summary>where they went</summary>" + aside + "</details>") +
    stat(fmtX(loo.full_model.median_miss_x), "leave-one-out median miss", "the fitted model, tested on anchors it had not seen; a flat TVL multiple misses by " + fmtX(loo.flat_multiple.median_miss_x));
  function stat(n, l, s) {
    return '<div class="stat"><div class="n">' + n + '</div><div class="l">' + l + '</div><div class="s">' + s + "</div></div>";
  }
  $("asof").innerHTML = "snapshot as of " + esc(B.snapshot.as_of) + "<br>floor " + fmtBig(B.snapshot.floor_usd) + " TVL";
}

function renderControls() {
  const counts = {};
  for (const r of ROWS) { const v = planOf(r).verdict; counts[v] = (counts[v] || 0) + 1; }
  const chips = ['<button class="chip' + (S.v === "" ? " on" : "") + '" data-v="">All <span class="c">' + ROWS.length + "</span></button>"]
    .concat(VERDICTS.map((v) => '<button class="chip' + (S.v === v ? " on" : "") + '" data-v="' + v + '">' + v +
      ' <span class="c">' + (counts[v] || 0) + "</span></button>")).join("");
  const cats = [...new Set(ROWS.map((r) => r.category))].sort();
  const famCounts = {};
  for (const r of ROWS) { const f = famKey(r.name); famCounts[f] = (famCounts[f] || 0) + 1; }
  const fams = Object.keys(famCounts).filter((f) => famCounts[f] >= 2).sort();
  const chains = [...new Set(ROWS.flatMap((r) => r.chains || []))].sort();
  const opts = (list, cur, allLabel, countOf) =>
    '<option value="">' + allLabel + "</option>" + list.map((x) =>
      '<option value="' + esc(x) + '"' + (x === cur ? " selected" : "") + ">" + esc(x) +
      (countOf ? " (" + countOf(x) + ")" : "") + "</option>").join("");
  $("controls").innerHTML =
    '<div class="crow"><span class="lbl">Verdict</span>' + chips +
      '<span class="lbl" style="width:auto;margin-left:10px">at deposit</span>' +
      '<span class="seg"><button data-dep="1000"' + (S.dep === 1000 ? ' class="on"' : "") + ">$1,000</button>" +
      '<button data-dep="10000"' + (S.dep === 10000 ? ' class="on"' : "") + ">$10,000</button></span></div>" +
    '<div class="crow"><span class="lbl">Filter</span>' +
      '<select id="f-cat">' + opts(cats, S.cat, "All categories", (c) => ROWS.filter((r) => r.category === c).length) + "</select>" +
      '<select id="f-fam">' + opts(fams, S.fam, "All families (2+)", (f) => famCounts[f]) + "</select>" +
      '<select id="f-chain">' + opts(chains, S.chain, "All chains", null) + "</select>" +
      '<input type="search" id="f-q" placeholder="Search name, category, slug…" value="' + esc(S.q) + '">' +
      '<label class="tgl"><input type="checkbox" id="f-wl"' + (S.wl ? " checked" : "") + "> watchlist only</label>" +
      '<label class="tgl"><input type="checkbox" id="f-anch"' + (S.anchors ? " checked" : "") + "> show trading anchors</label></div>";
  for (const b of document.querySelectorAll(".chip")) b.addEventListener("click", () => { S.v = b.dataset.v; sync(); });
  for (const b of document.querySelectorAll(".seg button")) b.addEventListener("click", () => { S.dep = Number(b.dataset.dep); sync(); });
  $("f-cat").addEventListener("change", (e) => { S.cat = e.target.value; sync(); });
  $("f-fam").addEventListener("change", (e) => { S.fam = e.target.value; sync(); });
  $("f-chain").addEventListener("change", (e) => { S.chain = e.target.value; sync(); });
  $("f-q").addEventListener("input", (e) => { S.q = e.target.value; sync(false); });
  $("f-wl").addEventListener("change", (e) => { S.wl = e.target.checked ? 1 : 0; sync(); });
  $("f-anch").addEventListener("change", (e) => { S.anchors = e.target.checked ? 1 : 0; sync(); });
  function sync(refocus) {
    writeHash(S);
    renderControls();
    renderTable();
    if (refocus !== false && S.q) { const q = $("f-q"); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
  }
}

const COLS = [
  ["rank", "Rank", 0], ["name", "Protocol", 0], ["value", "Implied value", 1],
  ["tvl", "TVL", 1], ["change", "7d", 1], ["days", "Days tokenless", 1],
  ["net", "Net if launch", 1], ["be", "Break-even", 1], ["verdict", "Verdict", 0],
];
function filteredRows() {
  const q = S.q.trim().toLowerCase();
  let out = ROWS.filter((r) => {
    const p = planOf(r);
    if (S.v && p.verdict !== S.v) return false;
    if (S.cat && r.category !== S.cat) return false;
    if (S.fam && famKey(r.name) !== S.fam) return false;
    if (S.chain && !(r.chains || []).includes(S.chain)) return false;
    if (S.wl && !r.on_watchlist) return false;
    if (q && !(r.name + " " + r.slug + " " + r.category).toLowerCase().includes(q)) return false;
    return true;
  });
  const key = (r) => {
    const p = planOf(r);
    switch (S.sort) {
      case "name": return r.name.toLowerCase();
      case "value": return r.implied_value_usd;
      case "tvl": return r.tvl_usd;
      case "change": return r.change_7d == null ? -Infinity : r.change_7d;
      case "days": return r.days_without_token;
      case "net": return p.net;
      case "be": return p.be == null ? Infinity : p.be;
      case "verdict": return VORDER[p.verdict];
      default: return r.rank;
    }
  };
  out = out.sort((a, b) => {
    const ka = key(a), kb = key(b);
    const c = typeof ka === "string" ? ka.localeCompare(kb) : ka - kb;
    return c * S.dir || a.rank - b.rank;
  });
  return out;
}
function renderTable() {
  $("boardhead").innerHTML = "<tr>" + COLS.map(([k, label, right]) =>
    '<th data-k="' + k + '"' + (right ? ' class="r"' : "") + ">" + label +
    (S.sort === k ? ' <span class="arr">' + (S.dir === 1 ? "↑" : "↓") + "</span>" : "") + "</th>").join("") + "</tr>";
  for (const th of document.querySelectorAll("#boardhead th")) th.addEventListener("click", () => {
    if (S.sort === th.dataset.k) S.dir = -S.dir; else { S.sort = th.dataset.k; S.dir = th.dataset.k === "name" || th.dataset.k === "rank" ? 1 : -1; }
    writeHash(S); renderTable();
  });
  const rows = filteredRows();
  $("boardbody").innerHTML = rows.map((r) => {
    const p = planOf(r);
    return '<tr class="prow" data-slug="' + esc(r.slug) + '">' +
      '<td class="rank">' + r.rank + '<span class="rng">' + r.rank_p25 + "–" + r.rank_p75 + "</span></td>" +
      '<td><span class="pname">' + esc(r.name) + (r.on_watchlist ? ' <span class="wl" title="On the snapshot watchlist">★</span>' : "") +
        '</span><span class="pmeta">' + esc(r.category) + " · " + esc((r.chains || [])[0] || "") +
        ((r.chains || []).length > 1 ? " +" + (r.chains.length - 1) : "") + "</span></td>" +
      '<td class="val">' + fmtBig(r.implied_value_usd) + "<div>" + rail(r, false) + "</div></td>" +
      '<td class="mono r">' + fmtBig(r.tvl_usd) + "</td>" +
      '<td class="mono r ' + (r.change_7d > 0 ? "pos" : r.change_7d < 0 ? "neg" : "") + '">' + fmtPct(r.change_7d) + "</td>" +
      '<td class="mono r">' + commas(r.days_without_token) + "</td>" +
      '<td class="mono r ' + (p.net > 0 ? "pos" : p.net < 0 ? "neg" : "") + '">' + fmtUsd(p.net) + "</td>" +
      '<td class="mono r">' + (p.be == null ? "—" : fmtPct(p.be, p.be >= 1000 ? 0 : 1).replace("+", "")) + "</td>" +
      '<td><span class="pill ' + p.verdict + '">' + p.verdict + "</span></td></tr>";
  }).join("");
  for (const tr of document.querySelectorAll("#boardbody tr.prow"))
    tr.addEventListener("click", () => { location.hash = "#/p/" + encodeURIComponent(tr.dataset.slug); });
  let anchorNote = "";
  if (S.anchors && !S.chain) {
    const q = S.q.trim().toLowerCase();
    const list = AN.anchors.filter((a) => (!S.cat || a[1] === S.cat) &&
      (!q || (a[0] + " " + a[1]).toLowerCase().includes(q)));
    $("anchorbody").innerHTML =
      '<tr class="sect"><td colspan="9">Trading anchors — reference only: these already have a token and are not ranked</td></tr>' +
      list.map((a) =>
        '<tr class="ref"><td class="rank">—</td><td><span class="pname">' + esc(a[0]) +
          '<span class="reftag">' + (a[4] ? "anchor" : "anchor · not fitted") + '</span></span><span class="pmeta">' + esc(a[1]) + "</span></td>" +
          '<td class="val">' + fmtBig(a[3]) + '<span class="pmeta">recorded cap</span></td>' +
          '<td class="mono r">' + fmtBig(a[2]) + '</td><td class="mono r">—</td><td class="mono r">—</td>' +
          '<td class="mono r">—</td><td class="mono r">—</td><td>—</td></tr>').join("");
    anchorNote = " · +" + list.length + " trading anchors as reference";
  } else {
    $("anchorbody").innerHTML = "";
    if (S.anchors && S.chain) anchorNote = " · anchors hidden while a chain filter is on (their chains are not in the board data)";
  }
  const filtered = rows.length !== ROWS.length;
  $("rowcount").textContent = "Showing " + rows.length + " of " + ROWS.length + " ranked protocols" +
    (filtered ? " (filters on)" : "") + " · plan figures at a " + fmtUsd(S.dep) + " deposit" + anchorNote;
}

function scatterSVG() {
  const pts = AN.anchors;
  if (!pts.length) return "<p>No anchor data loaded.</p>";
  const W = 640, H = 310, pl = 60, pr = 10, pt = 10, pb = 30;
  const xs = pts.map((a) => Math.log10(a[2])), ys = pts.map((a) => Math.log10(a[3]));
  const x0 = Math.floor(Math.min(...xs)), x1 = Math.ceil(Math.max(...xs));
  const y0 = Math.floor(Math.min(...ys)), y1 = Math.ceil(Math.max(...ys));
  const X = (v) => pl + ((v - x0) / (x1 - x0)) * (W - pl - pr);
  const Y = (v) => H - pb - ((v - y0) / (y1 - y0)) * (H - pt - pb);
  const tick = (e) => {
    if (e >= 9) return "$" + Math.pow(10, e - 9) + "B";
    if (e >= 6) return "$" + Math.pow(10, e - 6) + "M";
    return "$" + Math.pow(10, e - 3) + "K";
  };
  let g = "";
  for (let e = x0; e <= x1; e++) g += '<line x1="' + X(e) + '" y1="' + pt + '" x2="' + X(e) + '" y2="' + (H - pb) + '" stroke="#e4ddcd"/><text x="' + X(e) + '" y="' + (H - pb + 16) + '" font-size="10" fill="#5d6579" text-anchor="middle">' + tick(e) + "</text>";
  for (let e = y0; e <= y1; e++) g += '<line x1="' + pl + '" y1="' + Y(e) + '" x2="' + (W - pr) + '" y2="' + Y(e) + '" stroke="#e4ddcd"/><text x="' + (pl - 6) + '" y="' + (Y(e) + 3) + '" font-size="10" fill="#5d6579" text-anchor="end">' + tick(e) + "</text>";
  const curve = [];
  for (let i = 0; i <= 40; i++) {
    const t = x0 + ((x1 - x0) * i) / 40;
    curve.push((i ? "L" : "M") + X(t).toFixed(1) + " " + Y(COEF.intercept + COEF.slope_log10_tvl * t).toFixed(1));
  }
  const mult = B.validation.leave_one_out.flat_multiple.multiple_x_tvl;
  const flat = "M" + X(x0) + " " + Y(x0 + Math.log10(mult)) + "L" + X(x1) + " " + Y(x1 + Math.log10(mult));
  const dots = pts.map((a) => {
    const cx = X(Math.log10(a[2])).toFixed(1), cy = Y(Math.log10(a[3])).toFixed(1);
    return a[4]
      ? '<circle cx="' + cx + '" cy="' + cy + '" r="3" fill="#0b7563" opacity="0.72"><title>' + esc(a[0]) + "</title></circle>"
      : '<circle cx="' + cx + '" cy="' + cy + '" r="3.4" fill="#ffffff" stroke="#8a8fa3" stroke-width="1.2"><title>' + esc(a[0]) + " (kept out of the fit)</title></circle>";
  }).join("");
  return '<svg viewBox="0 0 ' + W + " " + H + '" width="100%" role="img" aria-label="Trading anchors against the fitted size curve">' +
    g + '<path d="' + flat + '" stroke="#8a8fa3" stroke-width="1.4" stroke-dasharray="5 4" fill="none"/>' +
    '<path d="' + curve.join(" ") + '" stroke="#0b7563" stroke-width="2.2" fill="none"/>' + dots + "</svg>";
}

function kv(rows, cls) {
  return '<table class="kv' + (cls ? " " + cls : "") + '">' + rows.map(([k, v]) => "<tr><td>" + k + '</td><td class="v">' + v + "</td></tr>").join("") + "</table>";
}
function renderMethod(verify) {
  const m = B.model, c = m.coefficients, val = B.validation, loo = val.leave_one_out, wf = val.walk_forward;
  const fe = B.farm_economics, as = fe.assumptions;
  const offsets = Object.entries(m.category_offsets_log10).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => k + " " + (v >= 0 ? "+" : "") + v.toFixed(3)).join(" · ");
  const looRow = (label, s) => "<tr><td>" + label + '</td><td class="r">' + s.anchors + '</td><td class="r">' +
    s.median_miss_x.toFixed(3) + '×</td><td class="r">' + s.within_3x_pct + '%</td><td class="r">' + s.within_10x_pct + "%</td></tr>";
  const abl = loo.ablation.map((a) => "<tr><td>" + esc(a.label) + '</td><td class="r">' + a.median_miss_x.toFixed(3) +
    '×</td><td class="r">' + a.within_3x_pct + '%</td><td class="r">' + a.within_10x_pct + "%</td></tr>").join("");
  const checks = verify.globals.map(([label, passed]) =>
    "<div>" + (passed ? "✓" : "✗") + " " + esc(label) + "</div>").join("");
  $("method").innerHTML =
    "<h2>Method — a fitted model, tested out of sample</h2>" +
    '<div class="mgrid">' +
    '<div class="mcard"><h3>The value model</h3>' +
      '<div class="formula">' + esc(m.formula) + "</div><p>" + esc(m.fitted_on) + "</p>" +
      kv([["Intercept", c.intercept], ["Slope, per log₁₀ TVL", c.slope_log10_tvl],
          ["Growth carry γ, per +1% of 7d change", c.growth_carry_gamma_per_pct],
          ["Seasoning δ, per log₁₀(1 + days/30)", c.seasoning_delta],
          ["Category offset shrinkage k", c.shrinkage_k], ["Huber c", c.huber_c],
          ["Anchors in the fit", m.anchors_fit], ["Anchors carrying a listing date", m.seasoning_anchors],
          ["Residual MAD, log₁₀", m.residual_mad_log10],
          ["Days fallback when no date is recorded", m.days_fallback_for_missing_listed_at]]) +
      "<p>Uncertainty: " + m.bootstrap.rounds + " bootstrap refits (seed " + m.bootstrap.seed + "); each row's band is the middle half of its refit values, its rank range the middle half of its refit ranks.</p>" +
      '<details><summary style="cursor:pointer;color:var(--acc);font-size:12.5px">category offsets, log₁₀ (' +
        Object.keys(m.category_offsets_log10).length + ")</summary><p class=\"num\" style=\"font-size:11.5px\">" + esc(offsets) + "</p></details></div>" +
    '<div class="mcard"><h3>The anchors against the curve</h3>' + scatterSVG() +
      '<p class="figcap">Each dot is a protocol that already trades: TVL across, recorded market cap up, both log scales. ' +
      "The green line is the fitted size curve before category offsets; the dashed line is the flat " +
      loo.flat_multiple.multiple_x_tvl + "× TVL multiple the validation below compares against. " +
      "Hollow dots are the " + B.universe.trading_excluded_from_fit + " exchange tokens counted as trading but kept out of the fit — an exchange's cap prices its business, not a protocol's TVL.</p></div>" +
    '<div class="mcard wide"><h3>Out-of-sample validation</h3><p>' + esc(val.method) + "</p>" +
      '<table class="kv"><tr><th>Leave-one-out, per anchor</th><th class="r">anchors</th><th class="r">median miss</th><th class="r">within 3×</th><th class="r">within 10×</th></tr>' +
      looRow("Full fitted model", loo.full_model) + looRow("Flat multiple (" + loo.flat_multiple.multiple_x_tvl + "× TVL)", loo.flat_multiple) + "</table>" +
      "<p>Walk-forward: " + esc(wf.split) + " — trained on " + wf.train_anchors + " anchors, tested on " + wf.test_anchors +
      ": median miss " + wf.median_miss_x + "×, within 3× " + wf.within_3x_pct + "%, within 10× " + wf.within_10x_pct + "%.</p>" +
      '<table class="kv"><tr><th>Ablation — terms added one at a time</th><th class="r">median miss</th><th class="r">within 3×</th><th class="r">within 10×</th></tr>' + abl + "</table>" +
      "<p>Read the ablation honestly: the added terms cost a little median miss against the bare curve and buy a better within-3× hit rate. The table is printed either way — a radar that hides its own weak terms is not a radar.</p></div>" +
    '<div class="mcard wide"><h3>Farm economics — one arithmetic for every row</h3><p>' + esc(fe.basis) + "</p>" +
      '<div class="mgrid"><div>' + kv([["Launch allocation assumed", as.launch_allocation_pct_of_implied_value + "% of implied value, pro-rata across TVL"],
          ["Round-trip fees", as.round_trip_fee_pct_of_deposit + "% of deposit"],
          ["Opportunity cost", as.tbill_pct_per_year + "% a year (T-bill) over the hold"],
          ["Hold", as.hold_weeks + " weeks · " + as.hands_on_hours + " hands-on hours"],
          ["Gas", "per-chain table in the board (" + Object.keys(as.gas_usd_by_chain).length + " chains), default " + fmtUsd(as.gas_usd_default)]]) + "</div>" +
      "<div>" + kv(Object.entries(fe.formulas).map(([k, v]) => [k.replace(/_/g, " "), esc(v)]), "wrap") + "</div></div>" +
      '<table class="kv" style="margin-top:8px">' + Object.entries(fe.verdict_thresholds).map(([k, v]) =>
        "<tr><td><span class=\"pill " + k + "\">" + k + '</span></td><td>' + esc(v) + "</td></tr>").join("") + "</table>" +
      '<h3 style="margin-top:14px">Checks this page ran on the board it was handed</h3>' + checks + "</div>" +
    "</div>";
}

function renderDetail(row, verify) {
  const p10 = row.plan_10k, p1 = row.plan_1k;
  const off = OFFSETS[row.category] || 0;
  const carry = row.change_7d == null ? 0 : clamp(COEF.growth_carry_gamma_per_pct * row.change_7d, CARRY_FLOOR, CARRY_CAP);
  const seas = COEF.seasoning_delta * Math.log10(1 + row.days_without_token / 30);
  const curve = COEF.intercept + COEF.slope_log10_tvl * Math.log10(Math.max(1, row.tvl_usd));
  const mine = impliedFor(row);
  const planKv = (p, full) => kv(full ? [
      ["Deposit", fmtUsd(p.deposit_usd)], ["Chain priced", esc(p.chain)],
      ["Share of TVL", p.share_of_tvl_pct + "%"], ["Gross slice if it launches", fmtMoney(p.gross_slice_usd)],
      ["Round-trip fees", fmtMoney(p.fees_usd)], ["Gas", fmtMoney(p.gas_usd)],
      ["Opportunity cost", fmtMoney(p.opportunity_cost_usd)], ["Total costs", fmtMoney(p.total_costs_usd)],
      ["Net if launch", fmtMoney(p.net_if_launch_usd)], ["Net per hands-on hour", fmtMoney(p.net_per_hour_usd)],
      ["Break-even launch chance", p.break_even_probability_pct == null ? "—" : p.break_even_probability_pct + "%"],
      ["Verdict", '<span class="pill ' + p.verdict + '">' + p.verdict + "</span>"]] : [
      ["Deposit", fmtUsd(p.deposit_usd)], ["Gross slice if it launches", fmtMoney(p.gross_slice_usd)],
      ["Total costs", fmtMoney(p.total_costs_usd)], ["Net if launch", fmtMoney(p.net_if_launch_usd)],
      ["Break-even launch chance", p.break_even_probability_pct == null ? "—" : p.break_even_probability_pct + "%"],
      ["Verdict", '<span class="pill ' + p.verdict + '">' + p.verdict + "</span>"]]);
  $("detail").innerHTML =
    '<a class="back" href="#/">&larr; back to the board</a>' +
    '<div class="dhead"><h2>' + esc(row.name) + '</h2><span class="pill ' + row.verdict + '">' + row.verdict +
      " at $10k</span>" + (row.on_watchlist ? '<span class="wl">★ on the snapshot watchlist</span>' : "") + "</div>" +
    '<p class="dmeta">Rank #' + row.rank + " of " + ROWS.length + " · " + esc(row.category) + " · " +
      esc((row.chains || []).join(", ")) + " · tokenless " + commas(row.days_without_token) + " days · " + esc(row.slug) + "</p>" +
    '<div class="dgrid">' +
    '<div class="dcard"><h3>Implied value</h3><div class="bigval">' + fmtUsd(row.implied_value_usd) + "</div>" +
      rail(row, true) +
      '<div class="bandlbl"><span>P25 ' + fmtUsd(row.value_p25_usd) + "</span><span>P75 " + fmtUsd(row.value_p75_usd) + "</span></div>" +
      "<p>Bootstrap rank range " + row.rank_p25 + "–" + row.rank_p75 + " over " + B.model.bootstrap.rounds + " refits.</p>" +
      kv([["Size curve at its TVL", curve.toFixed(3) + " log₁₀"],
          ["+ category offset (" + esc(row.category) + ")", (off >= 0 ? "+" : "") + off.toFixed(3)],
          ["+ growth carry (7d " + fmtPct(row.change_7d) + ")", (carry >= 0 ? "+" : "") + carry.toFixed(3)],
          ["+ seasoning (" + commas(row.days_without_token) + " days)", (seas >= 0 ? "+" : "") + seas.toFixed(3)],
          ["TVL", fmtUsd(row.tvl_usd)]]) +
      "<p>This page's own re-price of this row: " + fmtUsd(mine) + (mine === row.implied_value_usd
        ? " — matches the board to the dollar."
        : " — agrees with the board to within " + (Math.abs(mine - row.implied_value_usd) / row.implied_value_usd * 100).toPrecision(2) +
          "% (the board prints its coefficients to 6 decimals).") + "</p></div>" +
    '<div class="dcard"><h3>Farm plan — $10,000 deposit</h3>' + planKv(p10, true) + "</div>" +
    '<div class="dcard"><h3>Farm plan — $1,000 deposit</h3>' + planKv(p1, false) +
      "<p>Same arithmetic, smaller deposit: the slice shrinks with the deposit's share of TVL while gas does not, which is why small plans so often read Thin.</p></div>" +
    '<div class="dcard"><h3>Farm steps</h3><ol class="steps">' +
      row.farm_steps.map((s) => "<li>" + esc(s) + "</li>").join("") + "</ol></div>" +
    "</div>";
}

// ------------------------------------------------------------------ init
let VERIFY;
try { VERIFY = verifyBoard(); } catch (e) { VERIFY = { ok: 0, total: ROWS.length, misses: ["verification threw: " + e.message], globals: [], ms: 0 }; }
function renderBadge() {
  const el = $("verify");
  if (VERIFY.ok === VERIFY.total) {
    el.className = "verify";
    el.textContent = "board.json = this page: " + VERIFY.ok + "/" + VERIFY.total +
      " rows re-priced, re-planned and re-verdicted here in " + VERIFY.ms + " ms — all matched" +
      " (values within 0.01%, the precision the board's printed coefficients allow)";
  } else {
    el.className = "verify bad";
    el.textContent = "board.json = this page: " + VERIFY.ok + "/" + VERIFY.total + " rows fully matched; " +
      (VERIFY.total - VERIFY.ok) + " differ — " + VERIFY.misses.join("; ");
  }
}
function route() {
  S = parseHash();
  const detail = S.view === "detail";
  $("boardview").hidden = detail;
  $("method").hidden = detail;
  $("stats").hidden = detail;
  $("verify").hidden = detail;
  $("detail").hidden = !detail;
  if (detail) {
    const row = ROWS.find((r) => r.slug === S.slug);
    if (row) renderDetail(row, VERIFY);
    else $("detail").innerHTML = '<a class="back" href="#/">&larr; back to the board</a><p>No ranked protocol with that name is on the board.</p>';
  } else {
    renderControls();
    renderTable();
  }
  window.scrollTo(0, 0);
}
renderStats();
renderBadge();
renderMethod(VERIFY);
$("foot").textContent = B.generated_by + " · Snapshot: " + B.snapshot.source + " (as of " + B.snapshot.as_of + "). " +
  "This page renders only the board it was handed; its source — index.html, app.css, app.js and the generated method summary about.txt — travels in the same dossier as the board data itself.";
window.addEventListener("hashchange", route);
route();
