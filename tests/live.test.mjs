// Checks lib.js against the real LeetCode API (needs internet). Run with:  npm run test:live
// Uses a well-known public profile; nothing here is specific to your account.
import test from "node:test";
import assert from "node:assert/strict";

globalThis.chrome = { storage: { sync: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } } };
const lib = await import("../lib.js");
const PUBLIC_USER = "lee215";

test("fetchUser reads a real public profile", async () => {
  const u = await lib.fetchUser(PUBLIC_USER.toUpperCase()); // LeetCode usernames are case-insensitive
  assert.equal(u.username, PUBLIC_USER, "returns the canonical username");
  assert.ok(u.name.length > 0);
  assert.match(u.avatar, /^https:\/\//);
  assert.ok(Number.isInteger(u.ranking) && u.ranking > 0);
  for (const k of ["All", "Easy", "Medium", "Hard"]) assert.ok(Number.isInteger(u.solved[k]), "solved." + k);
  assert.equal(u.solved.All, u.solved.Easy + u.solved.Medium + u.solved.Hard);
  assert.ok(u.days instanceof Set);
  for (const d of u.days) assert.equal(d % 86400, 0, "calendar days are UTC midnights");
  assert.ok(Number.isInteger(u.activeDays));
});

test("fetchUser rejects a username that doesn't exist", async () => {
  await assert.rejects(lib.fetchUser("no-such-user-zz9-plural-z-alpha"), /No LeetCode user/);
});

test("detectMe is null without a signed-in session", async () => {
  assert.equal(await lib.detectMe(), null);
});

test("pairStats works on two real calendars", async () => {
  const [a, b] = await lib.fetchUsers([PUBLIC_USER, "votrubac"]);
  assert.ok(a && b);
  const p = lib.pairStats(a, b, lib.utcDay() - 400 * 86400);
  assert.equal(p.week.length, 7);
  assert.ok(p.best >= p.streak && p.points >= p.best);
});
