// Unit tests for the shared logic in lib.js. Run with:  npm test
import test from "node:test";
import assert from "node:assert/strict";

// ---- Fakes for the browser APIs lib.js touches ----
const store = { sync: {}, local: {} };
const area = k => ({
  get: async key => { const o = {}; for (const x of [].concat(key)) if (x in store[k]) o[x] = structuredClone(store[k][x]); return o; },
  set: async o => { Object.assign(store[k], structuredClone(o)); }
});
const badge = {};
globalThis.chrome = {
  storage: { sync: area("sync"), local: area("local") },
  permissions: { contains: async () => true, request: async () => true },
  action: { setBadgeText: o => (badge.text = o.text), setBadgeBackgroundColor: o => (badge.color = o.color) }
};

const DAY = 86400;
const today = Math.floor(Date.now() / 1000 / DAY) * DAY;
const days = (...offsets) => new Set(offsets.map(o => today - o * DAY));
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const user = (...offsets) => ({ days: days(...offsets) });

// Fake LeetCode: `calendars` maps username -> day offsets; anything else doesn't exist.
let calendars = {}, requests = [], failing = new Set(), inFlight = 0, maxInFlight = 0;
globalThis.fetch = async (_url, opts) => {
  const { query, variables } = JSON.parse(opts.body);
  requests.push({ query, variables, credentials: opts.credentials });
  inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
  await new Promise(r => setTimeout(r, 5));
  inFlight--;
  const json = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });
  if (query.includes("userStatus")) return json({ data: { userStatus: globalThis.__signedIn ? { username: globalThis.__signedIn, isSignedIn: true } : { username: "", isSignedIn: false } } });
  if (failing.has(variables.u)) return json({}, 500);
  const key = Object.keys(calendars).find(u => u.toLowerCase() === variables.u.toLowerCase());
  if (!key) return json({ errors: [{ message: "That user does not exist." }], data: { matchedUser: null } });
  const cal = {};
  for (const o of calendars[key]) { const d = today - o * DAY; if (new Date(d * 1000).getUTCFullYear() === variables.y) cal[d + 3600] = 1; } // not exactly midnight
  return json({ data: { matchedUser: {
    username: key, profile: { realName: "", userAvatar: null, ranking: 5 },
    submitStats: { acSubmissionNum: [{ difficulty: "All", count: 10 }, { difficulty: "Easy", count: 6 }] },
    userCalendar: { streak: 0, totalActiveDays: calendars[key].length, submissionCalendar: JSON.stringify(cal) }
  } } });
};
const reset = (state = { me: "me", friends: [] }) => {
  store.sync = { state: structuredClone(state) }; store.local = {};
  calendars = { me: [0, 1, 2], Alice: [0, 1], bob: [1] }; requests = []; failing = new Set(); maxInFlight = 0; globalThis.__signedIn = null;
};

const lib = await import("../lib.js");
const { pairStats, soloStreak, tierInfo, utcDay, secondsToReset, TIERS } = lib;

test("utcDay floors to UTC midnight and secondsToReset stays within a day", () => {
  assert.equal(utcDay(Date.UTC(2026, 0, 1, 23, 59, 59)), Date.UTC(2026, 0, 1) / 1000);
  assert.equal(utcDay(Date.UTC(2026, 0, 2, 0, 0, 0)), Date.UTC(2026, 0, 2) / 1000);
  const s = secondsToReset();
  assert.ok(s > 0 && s <= DAY);
});

test("soloStreak counts back from today, or from yesterday if today isn't done yet", () => {
  assert.equal(soloStreak(days()), 0);
  assert.equal(soloStreak(days(0)), 1);
  assert.equal(soloStreak(days(0, 1, 2)), 3);
  assert.equal(soloStreak(days(1, 2)), 2);
  assert.equal(soloStreak(days(2, 3)), 0);
  assert.equal(soloStreak(days(0, 2, 3)), 1);
});

test("pairStats: both solved every day since the start", () => {
  const p = pairStats(user(...range(0, 4)), user(...range(0, 4)), today - 4 * DAY);
  assert.deepEqual([p.streak, p.best, p.points, p.doneToday], [5, 5, 5, true]);
});

test("pairStats: days before the pair started never count", () => {
  const p = pairStats(user(...range(0, 30)), user(...range(0, 30)), today - 2 * DAY);
  assert.deepEqual([p.streak, p.best, p.points], [3, 3, 3]);
  assert.deepEqual(p.week.map(w => w.state), ["pre", "pre", "pre", "pre", "both", "both", "both"]);
});

test("pairStats: streak survives until the end of today when only one has solved", () => {
  const p = pairStats(user(...range(0, 5)), user(...range(1, 5)), today - 10 * DAY);
  assert.deepEqual([p.streak, p.points, p.doneToday, p.todayMe, p.todayFriend], [5, 5, false, true, false]);
  assert.equal(p.week.at(-1).state, "me");
  assert.equal(p.week.at(-1).today, true);
});

test("pairStats: a missed day breaks the streak but keeps points and best", () => {
  const p = pairStats(user(...range(0, 9)), user(0, 1, 3, 4, 5, 6), today - 9 * DAY);
  assert.deepEqual([p.streak, p.best, p.points], [2, 4, 6]);
});

test("pairStats: missing yesterday means the streak is gone", () => {
  const p = pairStats(user(...range(0, 9)), user(...range(2, 9)), today - 9 * DAY);
  assert.deepEqual([p.streak, p.best, p.points, p.doneToday], [0, 8, 8, false]);
  assert.deepEqual(p.week.slice(-2).map(w => w.state), ["me", "me"]);
});

test("pairStats: started today, nobody solved", () => {
  const p = pairStats(user(), user(), today);
  assert.deepEqual([p.streak, p.best, p.points], [0, 0, 0]);
  assert.equal(p.week.at(-1).state, "none");
  assert.equal(p.week.length, 7);
});

test("pairStats: week marks which side solved", () => {
  const p = pairStats(user(0, 2), user(1, 2), today - 6 * DAY);
  assert.deepEqual(p.week.map(w => w.state), ["none", "none", "none", "none", "both", "friend", "me"]);
});

test("tierInfo: levels, progress and level-up detection", () => {
  assert.deepEqual([tierInfo(0).level, tierInfo(0).name, tierInfo(0).justReached], [0, "Unlit", false]);
  assert.deepEqual([tierInfo(1).name, tierInfo(1).justReached], ["Spark", true]);
  assert.deepEqual([tierInfo(2).name, tierInfo(2).justReached, tierInfo(2).progress], ["Spark", false, 0.5]);
  assert.deepEqual([tierInfo(7).name, tierInfo(7).justReached, tierInfo(7).next.at], ["On Fire", true, 14]);
  assert.equal(tierInfo(99).name, "Wildfire");
  const top = tierInfo(1000);
  assert.deepEqual([top.level, top.next, top.progress], [TIERS.length - 1, null, 1]);
  for (let s = 0; s < 400; s++) { const t = tierInfo(s); assert.ok(t.progress >= 0 && t.progress <= 1, "progress in range at " + s); }
});

test("fetchUser: normalises days to UTC midnight, falls back to username, sends no cookies", async () => {
  reset();
  const u = await lib.fetchUser("alice");
  assert.equal(u.username, "Alice");
  assert.equal(u.name, "Alice");
  assert.deepEqual([...u.days].sort(), [today - DAY, today]);
  assert.deepEqual([u.streak, u.solved.All, u.solved.Easy, u.activeDays], [2, 10, 6, 2]);
  assert.ok(requests.every(r => r.credentials === "omit"));
  assert.deepEqual(requests.map(r => r.variables.y).sort(), [new Date().getUTCFullYear() - 1, new Date().getUTCFullYear()]);
});

test("fetchUser: clear errors for a missing user and for a server error", async () => {
  reset();
  await assert.rejects(lib.fetchUser("ghost"), /No LeetCode user "ghost"/);
  failing.add("bob");
  await assert.rejects(lib.fetchUser("bob"), /LeetCode returned 500/);
});

test("fetchUsers: keeps order, null for failures, limited concurrency", async () => {
  reset();
  calendars = Object.fromEntries(range(1, 12).map(i => ["u" + i, [0]]));
  failing.add("u3");
  const names = [...range(1, 12).map(i => "u" + i), "ghost"];
  const out = await lib.fetchUsers(names, 4);
  assert.deepEqual(out.map(u => u?.username ?? null), names.map(n => (n === "u3" || n === "ghost" ? null : n)));
  // 4 users x 2 requests each; +1 because a failed user's second request can still be finishing
  assert.ok(maxInFlight <= 9, "expected at most ~8 requests at once, saw " + maxInFlight);
  assert.deepEqual(await lib.fetchUsers([]), []);
});

test("getState: tolerates empty or malformed storage", async () => {
  store.sync = {};
  assert.deepEqual(await lib.getState(), { me: null, friends: [] });
  store.sync = { state: { me: "x", friends: "oops" } };
  assert.deepEqual(await lib.getState(), { me: "x", friends: [] });
});

test("addFriend: validation, canonical username, no duplicates", async () => {
  reset({ me: null, friends: [] });
  await assert.rejects(lib.addFriend("alice"), /Set your own username first/);
  reset();
  await assert.rejects(lib.addFriend("   "), /Enter a LeetCode username/);
  await assert.rejects(lib.addFriend("@ME"), /That's you/);
  await assert.rejects(lib.addFriend("ghost"), /No LeetCode user/);
  await lib.addFriend(" @alice ");
  let st = await lib.getState();
  assert.deepEqual(st.friends, [{ username: "Alice", start: today, points: 0, streak: 0, best: 0 }]);
  await assert.rejects(lib.addFriend("ALICE"), /Already streaking with ALICE/);
  await lib.addFriend("bob");
  st = await lib.getState();
  assert.deepEqual(st.friends.map(f => f.username), ["Alice", "bob"]);
});

test("addFriend: two adds at once don't create a duplicate", async () => {
  reset();
  await Promise.all([lib.addFriend("alice"), lib.addFriend("Alice")]);
  assert.equal((await lib.getState()).friends.length, 1);
});

test("addFriend: enforces the friend limit", async () => {
  reset({ me: "me", friends: range(1, lib.MAX_FRIENDS).map(i => ({ username: "f" + i, start: today })) });
  await assert.rejects(lib.addFriend("alice"), /up to 30 streaks/);
});

test("saveStats: merges into the latest state and keeps options and new friends", async () => {
  reset({ me: "me", friends: [{ username: "Alice", start: today, points: 0, streak: 0, best: 0, pinned: true }] });
  // a friend is added while a refresh is in flight
  const st = await lib.getState(); st.friends.push({ username: "bob", start: today, points: 0, streak: 0, best: 0 }); await lib.setState(st);
  await lib.saveStats({ Alice: { points: 4, streak: 2, best: 3, week: [], doneToday: true }, gone: { points: 9, streak: 9, best: 9 } });
  assert.deepEqual((await lib.getState()).friends, [
    { username: "Alice", start: today, points: 4, streak: 2, best: 3, pinned: true },
    { username: "bob", start: today, points: 0, streak: 0, best: 0 }
  ]);
});

test("updateFriend and removeFriend", async () => {
  reset({ me: "me", friends: [{ username: "Alice", start: 1 }, { username: "bob", start: 2 }] });
  await lib.updateFriend("bob", { pinned: true, muted: true });
  await lib.updateFriend("nobody", { pinned: true });
  assert.deepEqual((await lib.getState()).friends[1], { username: "bob", start: 2, pinned: true, muted: true });
  const st = await lib.removeFriend("Alice");
  assert.deepEqual(st.friends.map(f => f.username), ["bob"]);
  assert.deepEqual((await lib.getState()).friends.map(f => f.username), ["bob"]);
});

test("updateBadge: longest live streak, red while any is at risk, cleared when none", () => {
  lib.updateBadge([{ streak: 3, doneToday: true }, { streak: 12, doneToday: true }, { streak: 0, doneToday: false }]);
  assert.deepEqual(badge, { text: "12", color: "#2cbb5d" });
  lib.updateBadge([{ streak: 3, doneToday: false }, { streak: 12, doneToday: true }]);
  assert.deepEqual(badge, { text: "12", color: "#ef5350" });
  lib.updateBadge([{ streak: 0, doneToday: false }]);
  assert.equal(badge.text, "");
  lib.updateBadge([]);
  assert.equal(badge.text, "");
});

test("detectMe: session first, then what the content script remembered", async () => {
  reset();
  assert.equal(await lib.detectMe(), null);
  store.local.detected = "seen_on_page";
  assert.equal(await lib.detectMe(), "seen_on_page");
  globalThis.__signedIn = "cookie_user";
  assert.equal(await lib.detectMe(), "cookie_user");
  assert.equal(requests.at(-1).credentials, "include");
});
