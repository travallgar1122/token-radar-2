// screenshots.mjs — capture the three dossier screenshots of the v2 dashboard.
//
// The judge reads exactly three views, in this order: the board, one
// protocol's detail view, and a filtered view. Each is rendered for real in
// headless Chromium (Playwright's build) driven over CDP: navigate, wait
// until the page itself says the view is rendered (the self-verification
// badge and the view's own text), then capture the 1440x900 viewport.
//
// `chrome --screenshot` with a #fragment URL is not used: it captures before
// the hash router renders, which produces an empty frame.
//
// Output: screenshots/1-board.png, screenshots/2-detail.png,
// screenshots/3-filtered.png at the repository root, from out/dashboard/
// as main.ts just wrote it. Run main.ts first, then this, then main.ts
// again so the dossier is built from these very files.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pageBase = pathToFileURL(join(root, "out", "dashboard", "index.html")).href;
const shotsDir = join(root, "screenshots");
const chrome = join(
  homedir(),
  ".cache/ms-playwright/chromium-1248/chrome-linux64/chrome"
);
const PORT = 9337;
const WIDTH = 1440;
const HEIGHT = 900;

// One readiness probe per view: the page's own text must prove the view
// rendered — the badge counts only on the board, the detail view must show
// its plan figures, and the filtered view must admit its filters are on.
const SHOTS = [
  {
    file: "1-board.png",
    url: pageBase + "#/",
    ready:
      "!!document.querySelector('#verify') && " +
      "document.querySelector('#verify').textContent.includes('197/197') && " +
      "document.body.innerText.includes('Steakhouse Financial')",
  },
  {
    file: "2-detail.png",
    url: pageBase + "#/p/steakhouse-financial",
    ready:
      "document.body.innerText.includes('Steakhouse Financial') && " +
      "document.body.innerText.includes('Gross slice')",
  },
  {
    file: "3-filtered.png",
    url: pageBase + "#/?v=Marginal",
    ready:
      "document.body.innerText.includes('filters on') && " +
      "document.body.innerText.includes('Marginal')",
  },
];

if (!existsSync(chrome)) {
  process.stderr.write(`screenshots: no Chromium at ${chrome}\n`);
  process.exit(1);
}
if (!existsSync(join(root, "out", "dashboard", "index.html"))) {
  process.stderr.write("screenshots: out/dashboard missing — run main.ts first\n");
  process.exit(1);
}
mkdirSync(shotsDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function debuggerUrl() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const json = await res.json();
      if (json.webSocketDebuggerUrl) return json.webSocketDebuggerUrl;
    } catch {
      // Chrome is still starting.
    }
    await sleep(150);
  }
  throw new Error("Chrome CDP endpoint did not come up");
}

// A minimal CDP client: request/response by id over one WebSocket, with
// flatten-mode sessions so page calls carry a sessionId.
function cdpClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    ws.addEventListener("open", () => {
      resolve({
        send(method, params = {}, sessionId) {
          const id = nextId++;
          const msg = { id, method, params };
          if (sessionId) msg.sessionId = sessionId;
          ws.send(JSON.stringify(msg));
          return new Promise((res, rej) => pending.set(id, { res, rej }));
        },
        close: () => ws.close(),
      });
    });
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(`${msg.error.message} (${msg.error.code})`));
        else res(msg.result);
      }
    });
    ws.addEventListener("error", reject);
  });
}

async function waitReady(cdp, sessionId, expr, label) {
  for (let i = 0; i < 160; i++) {
    const r = await cdp.send(
      "Runtime.evaluate",
      { expression: `!!(${expr})`, returnByValue: true },
      sessionId
    );
    if (r.result && r.result.value === true) return;
    await sleep(150);
  }
  throw new Error(`screenshots: view never rendered: ${label}`);
}

const profile = join(tmpdir(), `radar-shots-${process.pid}`);
const proc = spawn(
  chrome,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" }
);

try {
  const cdp = await cdpClient(await debuggerUrl());
  const { targetId } = await cdp.send("Target.createTarget", {
    url: "about:blank",
  });
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false },
    sessionId
  );

  for (const shot of SHOTS) {
    await cdp.send("Page.navigate", { url: shot.url }, sessionId);
    await waitReady(cdp, sessionId, shot.ready, shot.file);
    await sleep(350); // let the last paint settle
    const shot1 = await cdp.send(
      "Page.captureScreenshot",
      { format: "png", fromSurface: true, captureBeyondViewport: false },
      sessionId
    );
    const bytes = Buffer.from(shot1.data, "base64");
    writeFileSync(join(shotsDir, shot.file), bytes);
    console.log(`${shot.file}: ${bytes.length} bytes`);
  }
  cdp.close();
} finally {
  proc.kill("SIGTERM");
}
