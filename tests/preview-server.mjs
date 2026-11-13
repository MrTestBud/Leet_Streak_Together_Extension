// Dev preview: serves the popup in a normal browser tab with a fake `chrome` API and fake LeetCode data,
// so the UI can be developed, tested and screenshotted without installing the extension.
//
//   node tests/preview-server.mjs          then open http://localhost:5599/?s=demo&reset
//
// Query options:  s=<scenario>  reset  calm (skip today's celebration)  open=<username>  perm=0  hold=<ms>
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5599;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json" };

// Runs in the page before popup.js.
function mock() {
  const q = new URLSearchParams(location.search);
  const scenario = q.get("s") || "demo";
  const DAY = 86400, today = Math.floor(Date.now() / 1000 / DAY) * DAY;
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const XSS = "<img src=x onerror=alert(1)>";
  // Days each user solved, as offsets back from today (0 = today).
  const USERS = {
    alex_dev: { name: "Alex", days: range(0, 140) },
    kai: { name: "Kai Tanaka", days: range(0, 103) },          // 104 days, done today
    priya: { name: "Priya Sharma", days: range(1, 34) },       // 34 days, hasn't solved today -> at risk
    arjun: { name: "Arjun Mehta", days: range(0, 11) },        // 12 days, done today
    sara: { name: "Sara Lopez", days: range(0, 6) },           // 7 days today -> level up
    leo: { name: "Leo Martin", days: range(1, 3) },            // 3 days, at risk
    nina: { name: "Nina Patel", days: [3, 4, 5, 9] },          // burned out
    newbie: { name: "New Bie", days: [] },
    [XSS]: { name: "<b>Evil</b><img src=x onerror=alert(2)>", days: range(0, 2) }
  };
  const SCENARIOS = {
    demo: ["priya", "kai", "arjun", "sara", "leo", "nina"],
    one: ["arjun"], risk: ["priya"], cold: ["nina"], level: ["sara"], xss: [XSS, "arjun"],
    empty: [], setup: [],
    many: Object.keys(USERS).filter(u => u !== "alex_dev")
  };

  const mem = { sync: {}, local: {} };
  for (const k of ["sync", "local"]) { try { Object.assign(mem[k], JSON.parse(sessionStorage.getItem("mock-" + k) || "{}")); } catch { /* fresh */ } }
  if (q.has("reset") || !sessionStorage.getItem("mock-seeded-" + scenario)) {
    mem.sync = {}; mem.local = {};
    const friends = (SCENARIOS[scenario] || []).map(u => ({ username: u, start: today - 120 * DAY, points: 0, streak: 0, best: 0 }));
    if (scenario === "demo") friends[0].pinned = true;
    mem.sync.state = { me: scenario === "setup" ? null : "alex_dev", friends };
    if (scenario === "setup") mem.local.detected = "alex_dev";
    if (q.has("calm")) mem.local.celebrated = Object.fromEntries(friends.map(f => [f.username, today]));
    sessionStorage.setItem("mock-seeded-" + scenario, 1);
    sessionStorage.setItem("mock-sync", JSON.stringify(mem.sync));
    sessionStorage.setItem("mock-local", JSON.stringify(mem.local));
  }
  const area = k => ({
    get: async key => { const o = {}; for (const x of [].concat(key)) if (x in mem[k]) o[x] = structuredClone(mem[k][x]); return o; },
    set: async o => { Object.assign(mem[k], structuredClone(o)); sessionStorage.setItem("mock-" + k, JSON.stringify(mem[k])); }
  });
  window.__badge = {}; window.__opened = []; window.__requests = 0;
  window.chrome = {
    storage: { sync: area("sync"), local: area("local"), onChanged: { addListener() {} } },
    permissions: { contains: async () => q.get("perm") !== "0", request: async () => true },
    tabs: { create: o => window.__opened.push(o.url) },
    action: { setBadgeText: o => (window.__badge.text = o.text), setBadgeBackgroundColor: o => (window.__badge.color = o.color), setBadgeTextColor() {} },
    runtime: { getURL: p => p }
  };

  const avatar = (name, i) => "data:image/svg+xml," + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="hsl(${(i * 67 + 200) % 360} 55% 42%)"/><text x="20" y="27" font-size="19" font-family="Segoe UI,Arial" font-weight="600" fill="#fff" text-anchor="middle">${name[0].toUpperCase()}</text></svg>`);
  const realFetch = window.fetch;
  window.fetch = async (url, opts) => {
    if (!String(url).includes("leetcode.com/graphql")) return realFetch(url, opts);
    window.__requests++;
    const { query, variables } = JSON.parse(opts.body);
    await new Promise(r => setTimeout(r, Number(q.get("delay") ?? 200)));
    if (q.has("offline")) throw new TypeError("Failed to fetch");
    const json = data => new Response(JSON.stringify({ data }), { headers: { "Content-Type": "application/json" } });
    if (query.includes("userStatus")) return json({ userStatus: { username: "", isSignedIn: false } });
    const key = Object.keys(USERS).find(u => u.toLowerCase() === variables.u.toLowerCase());
    if (!key || (q.get("fail") && q.get("fail") === key)) return json({ matchedUser: null });
    const u = USERS[key], idx = Object.keys(USERS).indexOf(key), cal = {};
    for (const o of u.days) {
      const d = today - o * DAY;
      if (new Date(d * 1000).getUTCFullYear() === variables.y) cal[d] = 2;
    }
    const n = 40 + u.days.length * 3 + idx * 17;
    return json({ matchedUser: {
      username: key,
      profile: { realName: u.name, userAvatar: key === XSS ? "" : avatar(u.name, idx), ranking: Math.max(1200, 400000 - n * 700) },
      submitStats: { acSubmissionNum: [{ difficulty: "All", count: n }, { difficulty: "Easy", count: n >> 1 }, { difficulty: "Medium", count: (n >> 2) + (n >> 3) }, { difficulty: "Hard", count: n >> 3 }] },
      userCalendar: { streak: 1, totalActiveDays: u.days.length, submissionCalendar: JSON.stringify(cal) }
    } });
  };

  // open=<username>: expand that row once the list is drawn (used for screenshots).
  if (q.get("open")) {
    const want = q.get("open"), timer = setInterval(() => {
      const card = [...document.querySelectorAll(".card:not(.skeleton)")].find(c => c.querySelector(".meta")?.textContent.startsWith("@" + want + " "));
      if (!card) return;
      clearInterval(timer);
      if (!card.classList.contains("open")) card.querySelector(".top").click();
      if (q.has("compare")) [...card.querySelectorAll(".acts button")].find(b => b.textContent === "Compare")?.click();
    }, 50);
  }
  // hold=<ms>: delay the window load event (headless Firefox screenshots fire on load).
  if (q.get("hold")) addEventListener("DOMContentLoaded", () => { const i = new Image(); i.src = "/__hold?ms=" + q.get("hold"); i.style.display = "none"; document.body.append(i); });
}

http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/__mock.js") { res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" }); return res.end(`(${mock})();`); }
  if (u.pathname === "/__hold") return void setTimeout(() => { res.writeHead(204); res.end(); }, Math.min(Number(u.searchParams.get("ms")) || 0, 15000));
  const file = path.join(ROOT, u.pathname === "/" ? "popup.html" : decodeURIComponent(u.pathname));
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end("not found"); }
  let body = fs.readFileSync(file);
  if (path.basename(file) === "popup.html") body = String(body).replace("<link", '<script src="/__mock.js"></script><link');
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
  res.end(body);
}).listen(PORT, "127.0.0.1", () => console.log(`Popup preview: http://localhost:${PORT}/?s=demo&reset`));
