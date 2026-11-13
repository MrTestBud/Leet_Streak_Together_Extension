// Regenerates docs/screenshots/*.png from the preview server using a headless Chromium browser.
//   npm run preview            (in one terminal)
//   node tests/screenshots.mjs "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../docs/screenshots");
const BASE = process.env.PREVIEW_URL || "http://localhost:5599/";
const BROWSER = process.argv[2];
if (!BROWSER) { console.error("Pass the path to Edge or Chrome."); process.exit(1); }
const PORT = 9344, sleep = ms => new Promise(r => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "lst-shots-"));
const proc = spawn(BROWSER, [`--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, "--headless=new", "--no-first-run", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });

// name, query, what to wait for, extra settle time, minimum height
const SHOTS = [
  ["list", "s=demo&reset&calm", ".card:not(.skeleton)", 2500],
  ["expanded", "s=demo&reset&calm&open=priya", ".card.open", 2500],
  ["celebrate", "s=demo&reset", ".fx", 520],
  ["compare", "s=demo&reset&calm&open=kai&compare", ".cmp table", 2500],
  ["at-risk-filter", "s=demo&reset&calm&filter=risk", ".card:not(.skeleton)", 2500],
  ["setup", "s=setup&reset", "#setup:not([hidden])", 800, 230],
  ["empty", "s=empty&reset", ".empty", 800]
];

try {
  let target;
  for (let i = 0; i < 40 && !target; i++) { await sleep(300); try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === "page"); } catch { /* starting */ } }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = m => { const d = JSON.parse(m.data); pending.get(d.id)?.(d.result); pending.delete(d.id); };
  const send = (method, params = {}) => new Promise(res => { pending.set(++id, res); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async expression => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;

  for (const [name, query, waitFor, settle, minHeight = 0] of SHOTS) {
    await send("Emulation.setDeviceMetricsOverride", { width: 380, height: 600, deviceScaleFactor: 2, mobile: false });
    await send("Page.navigate", { url: BASE + "?" + query });
    for (let i = 0; i < 100 && !(await ev(`!!document.querySelector(${JSON.stringify(waitFor)})`)); i++) await sleep(50);
    if (query.includes("filter=risk")) await ev(`document.querySelector(".filter.risk").click()`);
    await sleep(settle);
    const height = Math.max(minHeight, await ev(`Math.ceil(document.body.getBoundingClientRect().height)`));
    await send("Emulation.setDeviceMetricsOverride", { width: 380, height, deviceScaleFactor: 2, mobile: false });
    const { data } = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 380, height, scale: 1 } });
    fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(data, "base64"));
    console.log(`${name}.png  380x${height} @2x`);
  }
  ws.close();
} finally {
  proc.kill(); await sleep(800);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* still releasing */ }
}
