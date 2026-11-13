import {
  getState, setState, detectMe, fetchUser, fetchUsers, pairStats, addFriend, removeFriend, updateFriend, saveStats, updateBadge,
  hasAccess, requestAccess, tierInfo, utcDay, secondsToReset, MAX_FRIENDS
} from "./lib.js";

const $ = id => document.getElementById(id);
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
let me = null, renderId = 0, shownTotal = 0;
let rows = [];                                // one per friend: { f, fr, p, order, fresh, el }
const view = { sort: "smart", filter: "all" }; // remembered between popup opens
const open = new Set();                        // usernames whose details are expanded
let settled = false;                           // entrance animations play only on the first draw

// Tiny DOM builder: everything from LeetCode is inserted as text, never as HTML.
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...kids.flat().filter(k => k != null && k !== false));
  return el;
}
const show = id => ["perm", "setup", "main"].forEach(s => ($(s).hidden = s !== id));
const say = (id, text) => ($(id).textContent = text || "");

async function init() {
  if (!(await hasAccess())) { show("perm"); return; }
  const st = await getState();
  show(st.me ? "main" : "setup");
  if (!st.me) {
    $("total").hidden = true;
    const { detected } = await chrome.storage.local.get("detected");
    if (detected && !$("meInput").value) $("meInput").value = detected;
    return;
  }
  $("meName").textContent = st.me;
  await render(st);
}

// Fetch everyone's calendars, compute each pair's streak, then draw the list.
async function render(st) {
  const id = ++renderId, list = $("list");
  if (!st.friends.length) {
    rows = [];
    list.replaceChildren(h("div", { class: "empty" },
      h("div", { class: "empty-fire" }, "🔥"),
      h("b", {}, "No streak partners yet"),
      h("span", {}, "Add a friend's LeetCode username above, or open their profile and use the button on the page.")));
    $("total").hidden = true; $("tools").hidden = true; updateBadge([]);
    return;
  }
  if (!list.querySelector(".card")) list.replaceChildren(...st.friends.map(() => h("div", { class: "card skeleton" })));
  try {
    const [mine, frs] = await Promise.all([fetchUser(st.me), fetchUsers(st.friends.map(f => f.username))]);
    if (id !== renderId) return; // a newer render started
    me = mine;
    const { celebrated = {}, view: saved } = await chrome.storage.local.get(["celebrated", "view"]);
    Object.assign(view, saved);
    const today = utcDay(), stats = {};
    rows = st.friends.map((f, order) => {
      const fr = frs[order];
      if (!fr) return { f, order };
      const p = pairStats(me, fr, f.start);
      stats[f.username] = p;
      return { f, fr, p, order, fresh: p.doneToday && celebrated[f.username] !== today }; // fresh: first time we see today's win
    });
    if (rows.length === 1) open.add(rows[0].f.username);
    const fresh = rows.filter(r => r.fresh);
    if (fresh.length) shownTotal = Math.max(0, rows.reduce((n, r) => n + (r.p?.points || 0), 0) - fresh.length);
    settled = false;
    draw(fresh.length > 0);
    fresh.forEach((r, i) => {
      celebrated[r.f.username] = today;
      const el = r.el;
      setTimeout(() => celebrate(el, r.fr, r.p), 450 + i * 500);
      r.fresh = false;
    });
    await saveStats(stats);
    if (fresh.length) await chrome.storage.local.set({ celebrated });
  } catch (e) {
    if (id === renderId) list.replaceChildren(h("div", { class: "empty" }, h("b", {}, "Couldn't load streaks"), h("span", {}, e.message)));
  }
}

const stateOf = r => !r.p ? "err" : r.p.doneToday ? "done" : r.p.streak ? "risk" : "cold";
const SORTS = {
  // Needs attention: streaks I can still save first, then ones waiting on a friend, unlit, done.
  smart: (a, b) => urgency(a) - urgency(b) || (b.p?.streak || 0) - (a.p?.streak || 0),
  streak: (a, b) => (b.p?.streak || 0) - (a.p?.streak || 0) || (b.p?.points || 0) - (a.p?.points || 0),
  points: (a, b) => (b.p?.points || 0) - (a.p?.points || 0),
  name: (a, b) => a.f.username.localeCompare(b.f.username, undefined, { sensitivity: "base" }),
  new: (a, b) => b.order - a.order
};
const urgency = r => ({ risk: r.p?.todayMe ? 1 : 0, cold: 2, done: 3, err: 4 })[stateOf(r)];

// Draw the list from already-fetched data: filter, sort, pinned on top. No network.
function draw(showAll = false) {
  const list = $("list");
  const counts = { all: rows.length, risk: 0, done: 0, cold: 0 };
  rows.forEach(r => { if (stateOf(r) in counts) counts[stateOf(r)]++; });
  let filter = showAll || !counts[view.filter] ? "all" : view.filter;

  $("tools").hidden = rows.length < 2;
  $("sort").value = view.sort in SORTS ? view.sort : "smart";
  $("filters").replaceChildren(...[["all", "All"], ["risk", "At risk"], ["done", "Done"], ["cold", "Unlit"]]
    .filter(([k]) => k === "all" || counts[k])
    .map(([k, label]) => h("button", {
      class: `filter ${k}${k === filter ? " on" : ""}`, role: "tab", "aria-selected": String(k === filter),
      onclick: () => { view.filter = k; chrome.storage.local.set({ view }); draw(); }
    }, label, h("b", {}, String(counts[k])))));

  // Snapchat-style crown for the longest live streak (when there is someone to compare with).
  const live = rows.filter(r => r.p?.streak > 0);
  const crown = rows.length > 1 && live.length ? live.reduce((a, b) => (b.p.streak > a.p.streak ? b : a)).f.username : null;

  const sort = SORTS[view.sort] || SORTS.smart;
  const shown = rows.filter(r => filter === "all" || stateOf(r) === filter)
    .sort((a, b) => !!b.f.pinned - !!a.f.pinned || sort(a, b) || a.order - b.order);
  shown.forEach((r, i) => { r.el = r.p ? card(r, crown === r.f.username) : errCard(r.f); r.el.style.setProperty("--i", i); });
  list.classList.toggle("settled", settled); settled = true;
  list.replaceChildren(...shown.map(r => r.el));
  setTimeout(() => list.querySelectorAll(".xp i").forEach(b => (b.style.width = b.dataset.w)), 30);

  const pairs = rows.filter(r => r.p).map(r => r.p), total = pairs.reduce((n, p) => n + p.points, 0);
  $("total").hidden = false;
  countUp($("totalNum"), shownTotal, total);
  shownTotal = total;
  updateBadge(pairs);
}

const fmtLeft = s => `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, "0")}m ${String(s % 60).padStart(2, "0")}s`;
const fmtShort = s => `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
const fmtDate = day => new Date(day * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });

// One friend = one row (avatar, name, status, 🔥 count). Click the row to expand the details.
function card(r, crowned) {
  const { f, fr, p } = r;
  const tier = tierInfo(p.streak), state = stateOf(r), isOpen = open.has(f.username);
  const countdown = () => h("b", { class: "countdown" }, fmtLeft(secondsToReset()));
  // Row summary puts the timer first, so a long name can never push it out of view.
  const timed = text => [h("b", { class: "countdown short" }, fmtShort(secondsToReset())), " left · " + text];
  let status, brief;
  if (p.doneToday) { status = "Both solved today — streak is safe!"; brief = ["✔ Both solved today"]; }
  else if (!p.todayMe && !p.todayFriend) {
    status = p.streak ? "Neither of you has solved yet. Streak at risk!" : p.best ? "The flame went out. Both solve today to relight it." : "Both solve one today to light the flame.";
    brief = p.streak ? timed("nobody solved yet") : [p.best ? "Flame went out — relight it today" : "Both solve today to light it"];
  } else if (!p.todayMe) { status = `${fr.username} is done — your move!`; brief = p.streak ? timed("your move!") : ["Your move to light it"]; }
  else { status = `You're done. Waiting on ${fr.username}…`; brief = p.streak ? timed(`waiting on ${fr.username}`) : [`Waiting on ${fr.username}`]; }

  const num = h("b", { class: "num" }, String(r.fresh ? p.streak - 1 : p.streak));
  const letters = "SMTWTFS";
  const toggle = () => {
    const now = el.classList.toggle("open");
    now ? open.add(f.username) : open.delete(f.username);
    top.setAttribute("aria-expanded", String(now));
  };
  const top = h("div", {
    class: "top", role: "button", tabindex: "0", "aria-expanded": String(isOpen),
    onclick: toggle, onkeydown: e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } }
  },
    h("img", { src: fr.avatar || null, alt: "", referrerpolicy: "no-referrer", onerror: e => (e.target.style.visibility = "hidden") }),
    h("div", { class: "who" },
      h("b", {}, h("span", { class: "nm" }, fr.name),
        f.pinned && h("i", { class: "tag", title: "Pinned" }, "📌"),
        crowned && h("i", { class: "tag", title: "Your longest live streak" }, "👑"),
        p.streak >= 100 && h("i", { class: "tag", title: "100+ day streak" }, "💯"),
        f.muted && h("i", { class: "tag", title: "Reminders muted" }, "🔕")),
      h("span", { class: "brief" }, brief)),
    h("div", { class: "flame", title: `${p.streak}-day streak together` },
      state === "risk" && h("span", { class: "hourglass", title: "Streak ends at the UTC reset" }, "⏳"),
      h("span", { class: "fire" }, "🔥"), num),
    h("span", { class: "chev", "aria-hidden": "true" }, "›"));

  const el = h("div", { class: `card ${state} lv${tier.level}${isOpen ? " open" : ""}` },
    top,
    h("div", { class: "body" },
      h("div", { class: "meta" }, `@${fr.username} · ⭐ ${p.points} point${p.points === 1 ? "" : "s"} · best ${p.best} · since ${fmtDate(f.start)}`),
      h("div", { class: "level" },
        h("span", { class: "tier" }, tier.name),
        h("span", {}, tier.next ? `${p.streak} / ${tier.next.at} → ${tier.next.name}` : "Max level")),
      h("div", { class: "xp" }, h("i", { "data-w": Math.round(tier.progress * 100) + "%" })),
      h("div", { class: "week" }, p.week.map(w => h("div", {
        class: `day ${w.state}${w.today ? " now" : ""}`,
        title: { both: "Both solved", me: "Only you solved", friend: `Only ${fr.username} solved`, none: "Nobody solved", pre: "Before you teamed up" }[w.state]
      }, h("i", {}, w.state === "both" ? "✔" : ""), h("span", {}, w.today ? "Today" : letters[new Date(w.day * 1000).getUTCDay()])))),
      h("div", { class: "today" }, chip("You", p.todayMe), chip(fr.username, p.todayFriend)),
      h("div", { class: "status" }, h("span", {}, status),
        !p.doneToday && h("span", { class: "left" }, p.streak ? "Ends in " : "Resets in ", countdown())),
      h("div", { class: "acts" },
        !p.todayMe && h("button", { class: "go", onclick: () => chrome.tabs.create({ url: "https://leetcode.com/problemset/" }) }, "Solve now"),
        h("button", { onclick: () => toggleCompare(el, fr) }, "Compare"),
        h("button", { onclick: () => chrome.tabs.create({ url: `https://leetcode.com/u/${encodeURIComponent(fr.username)}/` }) }, "Profile"),
        h("button", { title: "Keep this streak at the top of the list", onclick: () => setOption(f, { pinned: !f.pinned }) }, f.pinned ? "Unpin" : "Pin"),
        h("button", { title: "Turn at-risk reminders for this streak on or off", onclick: () => setOption(f, { muted: !f.muted }) }, f.muted ? "Unmute" : "Mute"),
        h("button", { class: "rm", onclick: e => confirmRemove(e.currentTarget, f) }, "Remove")),
      h("div", { class: "cmp" })));
  el._num = num;
  return el;
}

function chip(label, ok) {
  return h("div", { class: `chip ${ok ? "ok" : ""}` }, h("i", {}, ok ? "✔" : ""), h("span", {}, label));
}

function errCard(f) {
  return h("div", { class: "card err open" },
    h("div", { class: "top" }, h("div", { class: "who" }, h("b", {}, f.username), h("span", { class: "brief" }, "Couldn't load this profile right now."))),
    h("div", { class: "body" }, h("div", { class: "acts" }, h("button", { class: "rm", onclick: e => confirmRemove(e.currentTarget, f) }, "Remove"))));
}

// Pin / mute: saved to the synced state, then redrawn from what we already have.
async function setOption(f, patch) {
  Object.assign(f, patch);
  await updateFriend(f.username, patch);
  draw();
}

// Removing resets the pair's start date, so ask twice.
function confirmRemove(btn, f) {
  if (btn.dataset.sure) {
    removeFriend(f.username).then(st => {
      rows = rows.filter(r => r.f.username !== f.username);
      open.delete(f.username);
      rows.length ? draw() : render(st);
    });
    return;
  }
  btn.dataset.sure = 1; btn.textContent = "Sure? Streak resets"; btn.classList.add("sure");
  setTimeout(() => { delete btn.dataset.sure; btn.textContent = "Remove"; btn.classList.remove("sure"); }, 3000);
}

function toggleCompare(el, fr) {
  const box = el.querySelector(".cmp");
  if (box.firstChild) { box.replaceChildren(); return; }
  const data = [
    ["Total solved", me.solved.All, fr.solved.All, 1],
    ["Easy", me.solved.Easy, fr.solved.Easy, 1],
    ["Medium", me.solved.Medium, fr.solved.Medium, 1],
    ["Hard", me.solved.Hard, fr.solved.Hard, 1],
    ["Current streak", me.streak, fr.streak, 1],
    ["Active days (this yr)", me.activeDays, fr.activeDays, 1],
    ["Global rank", me.ranking, fr.ranking, -1]
  ];
  const fmt = n => (n == null ? "–" : Number(n).toLocaleString());
  box.append(h("table", {},
    h("tr", {}, h("th", {}), h("th", {}, "You"), h("th", {}, fr.username)),
    data.map(([label, a, b, dir], i) => {
      const w = a == null || b == null || a === b ? 0 : (a - b) * dir > 0 ? 1 : 2;
      const tr = h("tr", {}, h("td", {}, label), h("td", { class: w === 1 ? "win" : null }, fmt(a)), h("td", { class: w === 2 ? "win" : null }, fmt(b)));
      tr.style.setProperty("--i", i);
      return tr;
    })));
}

// ---- Game effects ----
function countUp(el, from, to, ms = 700) {
  if (reduceMotion || from === to) { el.textContent = to; return; }
  const t0 = performance.now();
  const step = t => {
    const k = Math.max(0, Math.min(1, (t - t0) / ms)); // a frame's timestamp can be slightly before t0
    el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  el.textContent = to; // correct even if frames are throttled
  requestAnimationFrame(step);
}

function burst(host, x, y, count = 28) {
  if (reduceMotion) return;
  const layer = h("div", { class: "fx" });
  const colors = ["#ffa116", "#ffd166", "#ff6b35", "#2cbb5d", "#fff3c4"], emoji = ["🔥", "⭐", "✨"];
  for (let i = 0; i < count; i++) {
    const isEmoji = i % 5 === 0;
    const p = h("span", { class: isEmoji ? "bit emoji" : "bit" }, isEmoji ? emoji[i % emoji.length] : "");
    if (!isEmoji) p.style.background = colors[i % colors.length];
    p.style.left = x + "px"; p.style.top = y + "px";
    const ang = Math.random() * Math.PI * 2, dist = 50 + Math.random() * 110;
    const dx = Math.cos(ang) * dist, dy = Math.sin(ang) * dist - 30;
    p.animate([
      { transform: "translate(-50%,-50%) scale(.4)", opacity: 1 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) rotate(${Math.random() * 540 - 270}deg) scale(1)`, opacity: 1, offset: .6 },
      { transform: `translate(calc(-50% + ${dx * 1.1}px), calc(-50% + ${dy + 70}px)) rotate(${Math.random() * 720 - 360}deg) scale(.7)`, opacity: 0 }
    ], { duration: 900 + Math.random() * 600, easing: "cubic-bezier(.15,.7,.3,1)", fill: "forwards" });
    layer.append(p);
  }
  host.append(layer);
  setTimeout(() => layer.remove(), 1700);
}

function toast(text) {
  const t = $("toast");
  t.textContent = text; t.hidden = false;
  t.classList.remove("in"); void t.offsetWidth; t.classList.add("in");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 4200);
}

// Plays once per friend per day, the first time the popup sees that both have solved.
function celebrate(el, fr, p) {
  if (!el.isConnected) return;
  const tier = tierInfo(p.streak);
  el.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
  el.classList.add("celebrate");
  countUp(el._num, p.streak - 1, p.streak, 500);
  const flame = el.querySelector(".flame"), a = flame.getBoundingClientRect(), b = el.getBoundingClientRect();
  burst(el, a.left - b.left + a.width / 2, a.top - b.top + a.height / 2);
  flame.append(h("span", { class: "plus" }, "+1 ⭐"));
  if (tier.justReached) {
    toast(`🏆 Level up: ${tier.name}! ${p.streak}-day streak with ${fr.username}`);
    setTimeout(() => burst(document.body, document.body.clientWidth / 2, 70, 44), 250);
  } else toast(`🔥 Streak kept with ${fr.username}! +1 point each`);
  setTimeout(() => el.classList.remove("celebrate"), 1800);
}

// Live countdown to the UTC reset; reload the cards when the day rolls over.
let lastDay = utcDay();
setInterval(() => {
  if (utcDay() !== lastDay) { lastDay = utcDay(); init(); return; }
  const left = secondsToReset(), long = fmtLeft(left), short = fmtShort(left);
  document.querySelectorAll(".countdown").forEach(c => (c.textContent = c.classList.contains("short") ? short : long));
}, 1000);

// ---- Controls ----
async function busy(btn, fn) {
  btn.disabled = true;
  try { await fn(); } finally { btn.disabled = false; }
}

$("addBtn").onclick = () => busy($("addBtn"), async () => {
  say("msg", "");
  try {
    const u = await addFriend($("friendInput").value);
    $("friendInput").value = "";
    open.add(u.username); view.filter = "all"; // show the new streak expanded
    await init();
  } catch (e) { say("msg", e.message); }
});
$("friendInput").addEventListener("keydown", e => { if (e.key === "Enter") $("addBtn").click(); });
$("friendInput").maxLength = 40;
$("friendInput").title = `Up to ${MAX_FRIENDS} streaks`;
$("sort").onchange = () => { view.sort = $("sort").value; chrome.storage.local.set({ view }); draw(); };

$("meSave").onclick = () => busy($("meSave"), async () => {
  const name = $("meInput").value.trim().replace(/^@/, "");
  if (!name) return say("setupMsg", "Enter your LeetCode username");
  say("setupMsg", "");
  try {
    const u = await fetchUser(name);
    const st = await getState();
    st.me = u.username;
    st.friends = st.friends.filter(f => f.username.toLowerCase() !== u.username.toLowerCase());
    await setState(st); $("meInput").value = ""; await init();
  } catch (e) { say("setupMsg", e.message); }
});
$("meInput").addEventListener("keydown", e => { if (e.key === "Enter") $("meSave").click(); });

$("meDetect").onclick = () => busy($("meDetect"), async () => {
  say("setupMsg", "");
  const n = await detectMe();
  if (!n) return say("setupMsg", "Couldn't find a signed-in LeetCode session. Open leetcode.com once while signed in, or type your username.");
  $("meInput").value = n; $("meSave").click();
});

$("changeMe").onclick = async () => { const st = await getState(); st.me = null; await setState(st); renderId++; rows = []; $("list").replaceChildren(); init(); };
$("refresh").onclick = () => busy($("refresh"), init);

$("permBtn").onclick = async () => {
  say("permMsg", "");
  try { if (await requestAccess()) return init(); say("permMsg", "Access wasn't granted."); }
  catch (e) { say("permMsg", e.message); }
};

init();
