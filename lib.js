// Shared logic: LeetCode API, streak math, storage. Works in Chrome and Firefox (MV3).
const GQL = "https://leetcode.com/graphql";
export const ORIGINS = { origins: ["https://leetcode.com/*"] };
export const DAY = 86400; // LeetCode calendar days are UTC.

export const utcDay = (ms = Date.now()) => Math.floor(ms / 1000 / DAY) * DAY;
export const secondsToReset = () => utcDay() + DAY - Math.floor(Date.now() / 1000);

// Firefox lets the user revoke host access at any time, so check before fetching.
export const hasAccess = () => chrome.permissions.contains(ORIGINS).catch(() => true);
export const requestAccess = () => chrome.permissions.request(ORIGINS);

async function gql(query, variables, credentials = "omit") {
  let r;
  try {
    r = await fetch(GQL, {
      method: "POST",
      credentials,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables })
    });
  } catch {
    throw new Error("Can't reach leetcode.com. Check your connection.");
  }
  if (!r.ok) throw new Error("LeetCode returned " + r.status);
  const j = await r.json();
  if (!j.data && j.errors?.length) throw new Error(j.errors[0].message || "LeetCode error");
  return j.data;
}

const PROFILE_Q = `query p($u:String!,$y:Int){
  matchedUser(username:$u){
    username
    profile{ realName userAvatar ranking }
    submitStats:submitStatsGlobal{ acSubmissionNum{ difficulty count } }
    userCalendar(year:$y){ streak totalActiveDays submissionCalendar }
  }
}`;

// Who is signed in to leetcode.com? Tries the session cookie first, then falls back to
// what the content script last saw on a leetcode.com page (cookies can be partitioned).
export async function detectMe() {
  try {
    const d = await gql("query{ userStatus{ username isSignedIn } }", {}, "include");
    if (d?.userStatus?.isSignedIn && d.userStatus.username) return d.userStatus.username;
  } catch { /* fall through */ }
  const { detected } = await chrome.storage.local.get("detected");
  return detected || null;
}

// Fetch a public profile: solved counts, ranking, and the set of active UTC days
// (current + previous year, so streaks survive New Year).
export async function fetchUser(username) {
  const y = new Date().getUTCFullYear();
  const [a, b] = await Promise.all([
    gql(PROFILE_Q, { u: username, y }),
    gql(PROFILE_Q, { u: username, y: y - 1 }).catch(() => null)
  ]);
  const u = a?.matchedUser;
  if (!u) throw new Error(`No LeetCode user "${username}"`);
  const days = new Set();
  for (const src of [a, b]) {
    const raw = src?.matchedUser?.userCalendar?.submissionCalendar;
    if (!raw) continue;
    let cal = {};
    try { cal = JSON.parse(raw); } catch { /* ignore a malformed calendar */ }
    for (const [ts, n] of Object.entries(cal)) if (n > 0) days.add(utcDay(+ts * 1000));
  }
  const solved = {};
  for (const s of u.submitStats?.acSubmissionNum ?? []) solved[s.difficulty] = s.count;
  return {
    username: u.username,
    name: u.profile?.realName || u.username,
    avatar: u.profile?.userAvatar,
    ranking: u.profile?.ranking,
    solved,
    days,
    streak: soloStreak(days),
    activeDays: u.userCalendar?.totalActiveDays ?? 0
  };
}

export function soloStreak(days) {
  const today = utcDay();
  let d = days.has(today) ? today : today - DAY, n = 0;
  while (days.has(d)) { n++; d -= DAY; }
  return n;
}

// Together-streak: consecutive UTC days (since the pair started) where BOTH solved.
// Points: 1 each for every day both solved. Derived from the calendars, so it can't double count.
export function pairStats(a, b, start) {
  const today = utcDay();
  const both = d => a.days.has(d) && b.days.has(d);
  let points = 0, best = 0, run = 0;
  for (let d = start; d <= today; d += DAY) {
    if (both(d)) { points++; run++; best = Math.max(best, run); } else run = 0;
  }
  let d = both(today) ? today : today - DAY, streak = 0;
  while (d >= start && both(d)) { streak++; d -= DAY; }
  // Last 7 days for the week tracker: both | me | friend | none | pre (before the pair started).
  const week = [];
  for (let i = 6; i >= 0; i--) {
    const day = today - i * DAY;
    const m = a.days.has(day), f = b.days.has(day);
    week.push({ day, today: i === 0, state: day < start ? "pre" : m && f ? "both" : m ? "me" : f ? "friend" : "none" });
  }
  return {
    streak, best, points, week,
    todayMe: a.days.has(today), todayFriend: b.days.has(today),
    doneToday: both(today)
  };
}

// ---- Game layer: flame levels unlocked by streak length ----
export const TIERS = [
  { at: 0, name: "Unlit" },
  { at: 1, name: "Spark" },
  { at: 3, name: "Kindling" },
  { at: 7, name: "On Fire" },
  { at: 14, name: "Blazing" },
  { at: 30, name: "Inferno" },
  { at: 50, name: "Wildfire" },
  { at: 100, name: "Legendary" },
  { at: 365, name: "Eternal Flame" }
];
export function tierInfo(streak) {
  let level = 0;
  TIERS.forEach((t, i) => { if (streak >= t.at) level = i; });
  const cur = TIERS[level], next = TIERS[level + 1] || null;
  return {
    level, name: cur.name, next,
    progress: next ? (streak - cur.at) / (next.at - cur.at) : 1,
    justReached: level > 0 && streak === cur.at
  };
}

// ---- Storage (storage.sync: follows the user's browser account) ----
export async function getState() {
  const { state } = await chrome.storage.sync.get("state");
  return { me: state?.me || null, friends: Array.isArray(state?.friends) ? state.friends : [] };
}
export const setState = state => chrome.storage.sync.set({ state });

// Merge freshly computed stats into the latest saved state, so a slow refresh
// can't overwrite a friend that was added or removed in the meantime.
export async function saveStats(stats) {
  const st = await getState();
  let changed = false;
  for (const f of st.friends) {
    const s = stats[f.username];
    if (s && (f.points !== s.points || f.streak !== s.streak || f.best !== s.best)) {
      Object.assign(f, { points: s.points, streak: s.streak, best: s.best });
      changed = true;
    }
  }
  if (changed) await setState(st);
}

// Toolbar badge: longest live streak; green when today is done, red while it's at risk.
export function updateBadge(pairs) {
  const api = chrome.action;
  if (!api?.setBadgeText) return;
  const live = pairs.filter(p => p.streak > 0);
  if (!live.length) { api.setBadgeText({ text: "" }); return; }
  const risk = live.some(p => !p.doneToday);
  api.setBadgeText({ text: String(Math.max(...live.map(p => p.streak))) });
  api.setBadgeBackgroundColor({ color: risk ? "#ef5350" : "#2cbb5d" });
  api.setBadgeTextColor?.({ color: "#ffffff" });
}

// Fetch many profiles a few at a time, so a long friends list doesn't hammer LeetCode.
// Resolves to an array aligned with `names`; a profile that fails to load is null.
export async function fetchUsers(names, limit = 4) {
  const out = new Array(names.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < names.length) {
      const i = next++;
      try { out[i] = await fetchUser(names[i]); } catch { /* stays null */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, names.length) }, worker));
  return out;
}

export const MAX_FRIENDS = 30; // keeps storage.sync under its per-item quota and refreshes fast

// Change per-friend options (pinned, muted) on the latest saved state.
export async function updateFriend(username, patch) {
  const st = await getState();
  const f = st.friends.find(x => x.username === username);
  if (f) { Object.assign(f, patch); await setState(st); }
  return st;
}

export async function addFriend(username) {
  username = String(username || "").trim().replace(/^@/, "");
  if (!username) throw new Error("Enter a LeetCode username");
  let st = await getState();
  if (!st.me) throw new Error("Set your own username first");
  if (st.friends.length >= MAX_FRIENDS) throw new Error(`You can keep up to ${MAX_FRIENDS} streaks. Remove one first.`);
  if (username.toLowerCase() === st.me.toLowerCase()) throw new Error("That's you!");
  const dup = s => s.friends.some(f => f.username.toLowerCase() === username.toLowerCase());
  if (dup(st)) throw new Error("Already streaking with " + username);
  const u = await fetchUser(username); // validates the id exists
  st = await getState();
  if (dup(st)) return u;
  st.friends.push({ username: u.username, start: utcDay(), points: 0, streak: 0, best: 0 });
  await setState(st);
  return u;
}

export async function removeFriend(username) {
  const st = await getState();
  st.friends = st.friends.filter(f => f.username !== username);
  await setState(st);
  return st;
}
