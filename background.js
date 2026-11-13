import { getState, fetchUser, fetchUsers, pairStats, addFriend, saveStats, updateBadge, hasAccess, utcDay, secondsToReset } from "./lib.js";

// Firefox doesn't keep alarms across restarts, so (re)create it every time the background starts.
async function ensureAlarm() {
  if (!(await chrome.alarms.get("check"))) chrome.alarms.create("check", { delayInMinutes: 1, periodInMinutes: 60 });
}
ensureAlarm();
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
chrome.alarms.onAlarm.addListener(a => { if (a.name === "check") check(); });

chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  (async () => {
    if (msg?.type === "add") { await addFriend(msg.username); reply({ ok: true }); }
    else if (msg?.type === "state") reply({ ok: true, state: await getState() });
    else reply({ ok: false, error: "Unknown message" });
  })().catch(e => reply({ ok: false, error: e.message }));
  return true;
});

chrome.notifications.onClicked.addListener(id => {
  chrome.notifications.clear(id);
  chrome.tabs.create({ url: "https://leetcode.com/problemset/" });
});

// Hourly: refresh saved points/streaks and nudge when a streak is at risk.
async function check() {
  const st = await getState();
  if (!st.me || !st.friends.length) { updateBadge([]); return; }
  if (!(await hasAccess())) return;
  const { notified = {} } = await chrome.storage.local.get("notified");
  const today = String(utcDay());
  try {
    const me = await fetchUser(st.me);
    const stats = {}, pairs = [];
    // Nudge in the local evening, or whenever the UTC day is about to roll over.
    const late = new Date().getHours() >= 16 || secondsToReset() <= 3 * 3600;
    const frs = await fetchUsers(st.friends.map(f => f.username));
    const risky = []; // streaks to warn about now (not muted, not already warned today)
    st.friends.forEach((f, i) => {
      const fr = frs[i];
      if (!fr) return;
      const p = pairStats(me, fr, f.start);
      stats[f.username] = p; pairs.push(p);
      const key = f.username + today;
      if (p.streak > 0 && !p.doneToday && !f.muted && !notified[key] && late) { notified[key] = 1; risky.push({ f, p }); }
    });
    const icon = chrome.runtime.getURL("icon.png");
    if (risky.length === 1) {
      const { f, p } = risky[0];
      const who = !p.todayMe && !p.todayFriend ? "Neither of you has" : !p.todayMe ? "You haven't" : `${f.username} hasn't`;
      chrome.notifications.create("risk" + today, {
        type: "basic", iconUrl: icon,
        title: `🔥 ${p.streak}-day streak with ${f.username} at risk`,
        message: `${who} solved a problem today. Both need one to keep it going.`
      });
    } else if (risky.length > 1) {
      // One summary instead of a notification per friend.
      const names = risky.sort((a, b) => b.p.streak - a.p.streak).map(r => `${r.f.username} (🔥${r.p.streak})`);
      const mine = risky.some(r => !r.p.todayMe);
      chrome.notifications.create("risk" + today, {
        type: "basic", iconUrl: icon,
        title: `⏳ ${risky.length} streaks at risk`,
        message: `${names.slice(0, 4).join(", ")}${names.length > 4 ? ` and ${names.length - 4} more` : ""}. ${mine ? "You haven't solved today — one problem saves them all." : "Waiting on your friends to solve."}`
      });
    }
    await saveStats(stats);
    updateBadge(pairs);
    await chrome.storage.local.set({ notified: Object.fromEntries(Object.entries(notified).filter(([k]) => k.endsWith(today))) });
  } catch (e) { console.warn("check failed", e); }
}
