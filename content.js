// Adds an "Add to Streak Together" button on LeetCode profile pages (/u/<name>).
(() => {
  let btn = null, lastPath = "", timer = 0;

  const profileName = () => {
    const m = location.pathname.match(/^\/u\/([^/]+)/);
    try { return m ? decodeURIComponent(m[1]) : null; } catch { return null; }
  };
  const send = msg => new Promise(res => {
    try { chrome.runtime.sendMessage(msg, r => res(chrome.runtime.lastError ? null : r)); }
    catch { res(null); } // extension was reloaded or removed
  });
  const clear = () => { btn?.remove(); btn = null; };

  async function render() {
    const name = profileName();
    if (!name) return clear();
    const r = await send({ type: "state" });
    const st = r?.state;
    if (name !== profileName()) return; // navigated away while waiting
    if (!st || !st.me || st.me.toLowerCase() === name.toLowerCase()) return clear();
    const already = st.friends.some(f => f.username.toLowerCase() === name.toLowerCase());
    if (!btn) { btn = document.createElement("button"); btn.id = "lst-btn"; btn.type = "button"; document.body.appendChild(btn); }
    btn.className = already ? "done" : "";
    btn.textContent = already ? `🔥 Streaking with ${name}` : `🔥 Streak together with ${name}`;
    btn.disabled = already;
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = "Adding…";
      const res = await send({ type: "add", username: name });
      if (!res?.ok) { btn.textContent = res?.error || "Couldn't add"; clearTimeout(timer); timer = setTimeout(render, 2500); }
      else { btn.classList.add("pop"); render(); }
    };
  }

  // Remember which account is signed in, so the popup's "Detect" works even when the
  // browser doesn't share leetcode.com cookies with extension pages.
  async function rememberUser() {
    try {
      const csrf = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/)?.[1];
      const r = await fetch("/graphql", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...(csrf ? { "x-csrftoken": csrf } : {}) },
        body: JSON.stringify({ query: "query{ userStatus{ username isSignedIn } }", variables: {} })
      });
      const u = (await r.json())?.data?.userStatus;
      await chrome.storage.local.set({ detected: u?.isSignedIn && u.username ? u.username : "" });
    } catch { /* not critical */ }
  }

  setInterval(() => { if (location.pathname !== lastPath) { lastPath = location.pathname; render(); } }, 800);
  try { chrome.storage.onChanged.addListener((_c, area) => { if (area === "sync") render(); }); } catch { /* ignore */ }
  rememberUser();
})();
