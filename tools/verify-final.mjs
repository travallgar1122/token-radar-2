// verify-final.mjs — Blok 6's local gate pass over out/.
//
// Re-implements the kit's seven sealed gate rows against the final output
// directory, so a FAIL here means a FAIL at intake, before any bundle is
// made: dashboard files, board file, sorted by value, watchlist coverage,
// farm steps, screenshots, and dossier_matches (recomputed byte for byte
// with the kit's own buildDossier). Also checks the harness's determinism
// rule by comparing out/ against a second run in out-test/ when present.
//
// Usage: node tools/verify-final.mjs <snapshot.json> [outDir] [secondOutDir]

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDossier } from "../vendor/makefun-board.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const snapshotPath = process.argv[2];
const outDir = process.argv[3] || join(root, "out");
const secondDir = process.argv[4] || null;
if (!snapshotPath) {
  process.stderr.write("verify-final: pass the snapshot path\n");
  process.exit(2);
}
const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
const rows = [];
const check = (name, ok, detail) => rows.push({ name, ok, detail });

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push({ path: p, rel: p.slice(base.length + 1), bytes: statSync(p).size });
  }
  return out;
}

// 1. dashboard_files -------------------------------------------------------
const dashDir = join(outDir, "dashboard");
const dashFiles = existsSync(dashDir) ? walk(dashDir) : [];
const dashBytes = dashFiles.reduce((a, f) => a + f.bytes, 0);
const nameOk = (n) =>
  /^[A-Za-z0-9._-]{1,128}$/.test(n) && !n.startsWith(".") && !n.startsWith("-");
let dashProblem = "";
if (!dashFiles.some((f) => f.rel === "index.html")) dashProblem = "no index.html";
if (!dashFiles.some((f) => f.rel.endsWith(".css"))) dashProblem = "no .css file";
if (!dashFiles.some((f) => f.rel.endsWith(".js"))) dashProblem = "no .js file";
if (dashFiles.length > 400) dashProblem = `${dashFiles.length} files > 400`;
if (dashBytes > 4 * 1024 * 1024) dashProblem = `${dashBytes} bytes > 4 MiB`;
for (const f of dashFiles) {
  if (!nameOk(f.rel.split("/").pop())) dashProblem = `bad file name ${f.rel}`;
}
// No network address in a loadable position: HTML attribute values, style
// bodies, script imports, CSS, or JS module specifiers. Visible text and
// comments may carry URLs, so only the loadable patterns are refused.
const netPatterns = [
  /<(?:a|link|script|img|iframe|source|use)\b[^>]*(?:href|src)\s*=\s*["']https?:\/\//i,
  /<style[^>]*>[\s\S]*?https?:\/\//i,
  /@import\s+["']https?:\/\//i,
  /url\(\s*["']?https?:\/\//i,
  /(?:import|export)\s[^"']*["']https?:\/\//,
  /require\(\s*["']https?:\/\//,
  /import\(\s*["']https?:\/\//,
];
for (const f of dashFiles) {
  if (!/\.(html|css|js|mjs)$/.test(f.rel)) continue;
  const text = readFileSync(f.path, "utf8");
  if (f.rel.endsWith(".css") && /https?:\/\//.test(text)) {
    dashProblem = `network address in CSS ${f.rel}`;
  }
  for (const re of netPatterns) {
    if (re.test(text)) dashProblem = `network address in ${f.rel}: ${re.source.slice(0, 40)}`;
  }
}
check(
  "dashboard_files",
  dashProblem === "",
  dashProblem || `${dashFiles.length} files, ${dashBytes} bytes, names and network scan clean`
);

// 2 + 3 + 4 + 5. board rows -------------------------------------------------
const boardPath = join(outDir, "board.json");
const boardBytes = statSync(boardPath).size;
const board = JSON.parse(readFileSync(boardPath, "utf8"));
const brows = Array.isArray(board) ? board : board.rows;
const protoSlugs = new Set(snapshot.protocols.map((p) => p.slug));
let boardProblem = "";
if (!Array.isArray(brows) || brows.length < 100 || brows.length > 4000)
  boardProblem = `rows ${brows && brows.length} outside 100..4000`;
if (boardBytes > 8 * 1024 * 1024) boardProblem = `board ${boardBytes} bytes > 8 MiB`;
const seenSlugs = new Set();
for (const r of brows) {
  if (!protoSlugs.has(r.slug)) { boardProblem = `invented slug ${r.slug}`; break; }
  if (seenSlugs.has(r.slug)) { boardProblem = `duplicate slug ${r.slug}`; break; }
  seenSlugs.add(r.slug);
  if (typeof r.name !== "string" || r.name.length === 0) { boardProblem = `empty name ${r.slug}`; break; }
  if (!Number.isInteger(r.rank) || r.rank <= 0) { boardProblem = `bad rank ${r.slug}`; break; }
  if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd <= 0 ||
      r.implied_value_usd > 100_000_000_000_000) { boardProblem = `bad value ${r.slug}`; break; }
  if (!Array.isArray(r.farm_steps)) { boardProblem = `farm_steps not an array ${r.slug}`; break; }
}
check("board_file", boardProblem === "", boardProblem || `${brows.length} rows, ${boardBytes} bytes`);

const byRank = [...brows].sort((a, b) => a.rank - b.rank);
let sortProblem = "";
for (let i = 0; i < byRank.length; i++) {
  if (byRank[i].rank !== i + 1) { sortProblem = `rank ${byRank[i].rank} at position ${i + 1}`; break; }
  if (i > 0 && byRank[i].implied_value_usd > byRank[i - 1].implied_value_usd) {
    sortProblem = `value rises at rank ${byRank[i].rank}`; break;
  }
}
if (new Set(brows.map((r) => r.implied_value_usd)).size === 1) sortProblem = "all values equal";
check("sorted_by_value", sortProblem === "", sortProblem || "ranks 1..N, values non-increasing");

const missing = snapshot.watchlist.filter((s) => !seenSlugs.has(s));
check(
  "coverage",
  missing.length === 0,
  missing.length ? `missing ${missing.join(", ")}` : `watchlist ${snapshot.watchlist.length}/${snapshot.watchlist.length}`
);

let stepProblem = "";
for (const r of brows) {
  if (r.farm_steps.length < 3 || r.farm_steps.length > 12) {
    stepProblem = `${r.slug}: ${r.farm_steps.length} steps`; break;
  }
  for (const s of r.farm_steps) {
    const n = typeof s === "string" ? s.trim().length : 0;
    if (n < 20 || n > 600) { stepProblem = `${r.slug}: step of ${n} chars`; break; }
  }
  if (stepProblem) break;
}
check("farm_steps", stepProblem === "", stepProblem || "every row 3..12 steps of 20..600 chars");

// 6. screenshots -------------------------------------------------------------
const shotsDir = join(outDir, "screenshots");
const shotFiles = existsSync(shotsDir)
  ? readdirSync(shotsDir).filter((n) => !n.startsWith("."))
  : [];
let shotProblem = "";
const shotDetail = [];
if (shotFiles.length < 3 || shotFiles.length > 4) shotProblem = `${shotFiles.length} images`;
for (const name of shotFiles) {
  const buf = readFileSync(join(shotsDir, name));
  const isPng = buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47;
  const isJpg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8;
  let w = 0, h = 0;
  if (isPng) { w = buf.readUInt32BE(16); h = buf.readUInt32BE(20); }
  if (buf.length > 512 * 1024) shotProblem = `${name} ${buf.length} bytes > 512 KiB`;
  if (!isPng && !isJpg) shotProblem = `${name} is not a whole PNG or JPEG`;
  if (isPng && (Math.max(w, h) > 1440 || Math.min(w, h) < 800))
    shotProblem = `${name} ${w}x${h} outside limits`;
  shotDetail.push(`${name} ${buf.length} B ${isPng ? `${w}x${h} PNG` : "JPEG"}`);
}
check("screenshots", shotProblem === "", shotProblem || shotDetail.join("; "));

// 7. dossier_matches -----------------------------------------------------------
const dossierPath = join(outDir, "dossier.json");
const dossierBytes = existsSync(dossierPath) ? statSync(dossierPath).size : 0;
let dossierProblem = "";
if (!existsSync(dossierPath)) dossierProblem = "no dossier.json";
else {
  const rebuilt = buildDossier(outDir, { text_max_bytes: 65536 });
  const rebuiltBytes = typeof rebuilt === "string" ? Buffer.from(rebuilt, "utf8") : Buffer.from(rebuilt);
  if (!rebuiltBytes.equals(readFileSync(dossierPath))) dossierProblem = "dossier differs from buildDossier output";
  if (dossierBytes > 1.5 * 1024 * 1024) dossierProblem = `dossier ${dossierBytes} bytes > 1.5 MiB`;
}
check(
  "dossier_matches",
  dossierProblem === "",
  dossierProblem || `byte-identical to buildDossier output, ${dossierBytes} bytes`
);

// Determinism across the two runs, when a second output directory is given.
if (secondDir) {
  const same = (rel) =>
    readFileSync(join(outDir, rel)).equals(readFileSync(join(secondDir, rel)));
  const okBoard = same("board.json");
  const okDossier = same("dossier.json");
  check("determinism", okBoard && okDossier, `board identical ${okBoard}, dossier identical ${okDossier}`);
}

let failed = 0;
for (const r of rows) {
  console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name} — ${r.detail}`);
  if (!r.ok) failed++;
}
console.log(failed === 0 ? "ALL GATES PASS" : `${failed} GATE(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
