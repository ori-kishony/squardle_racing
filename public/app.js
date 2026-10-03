// Squaredle Express Racing client (vanilla, mobile-first).
const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

const S = {
  roomCode: store.get("roomCode") || "KINGS",
  nickname: store.get("nickname") || "",
  playerId: store.get("playerId") || "",
  raceId: store.get("raceId") || "",
  date: "",
  grid: null,
  myWords: new Set(),
  path: [],
  timer: null,
  ws: null,
  serverSkew: 0,
};
$("roomCode").value = S.roomCode;
if (S.nickname) $("nickname").value = S.nickname;

async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...opts,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

function show(id) {
  for (const v of ["joinView", "lobbyView", "raceView", "resultsView", "adminView"])
    $(v).classList.add("hidden");
  if (id) $(id).classList.remove("hidden");
}

async function refreshKing() {
  try {
    const k = await api(`/api/rooms/${encodeURIComponent(S.roomCode)}/king`);
    if (k.king) {
      $("kingBanner").classList.remove("hidden");
      $("kingBanner").textContent =
        `👑 King ${k.king.nickname} — ${k.reignDays}-day reign · ${k.streak}-win streak`;
    } else $("kingBanner").classList.add("hidden");
  } catch { /* no king yet */ }
}

// ---------- join / lobby ----------
$("joinBtn").onclick = async () => {
  S.roomCode = ($("roomCode").value || "KINGS").toUpperCase();
  S.nickname = $("nickname").value.trim();
  if (!S.nickname) return alert("Pick a nickname");
  store.set("roomCode", S.roomCode);
  store.set("nickname", S.nickname);
  const j = await api("/api/rooms/join", {
    method: "POST",
    body: JSON.stringify({ roomCode: S.roomCode, nickname: S.nickname }),
  });
  S.playerId = j.playerId; S.raceId = j.raceId; S.date = j.date;
  store.set("playerId", S.playerId); store.set("raceId", S.raceId);
  connect();
  await sync();
  await refreshKing();
};

$("readyBtn").onclick = async () => {
  const me = (await sync())?.players.find((p) => p.playerId === S.playerId);
  await api(`/api/races/${S.raceId}/ready`, {
    method: "POST",
    body: JSON.stringify({ playerId: S.playerId, ready: !(me && me.ready) }),
  });
  await sync();
};

async function sync() {
  if (!S.raceId) return null;
  const v = await api(`/api/races/${S.raceId}?playerId=${encodeURIComponent(S.playerId)}`);
  S.serverSkew = v.race.serverNow - Date.now();
  render(v);
  return v;
}

function render(v) {
  S.date = v.race.date;
  $("lobbyDate").textContent = `· ${v.race.date} · room ${v.race.roomCode}`;
  if (v.race.status === "lobby" || v.race.status === "countdown") {
    show("lobbyView");
    $("playerList").innerHTML = v.players
      .map((p) => `<li><span>${escapeHtml(p.nickname)} <b>${p.acronym}</b></span><span class="${p.ready ? "ready" : ""}">${p.ready ? "✓ ready" : "…"}</span></li>`)
      .join("");
    const me = v.players.find((p) => p.playerId === S.playerId);
    $("readyBtn").textContent = me && me.ready ? "Not ready" : "I'm Ready";
  }
  if (v.race.status === "countdown") startCountdown(v.race.startsAt);
  else stopCountdown();

  if (v.race.status === "live" || v.race.status === "done") {
    show("raceView");
    if (v.grid) buildBoard(v.grid);
    $("reqTotal").textContent = v.requiredCount;
    S.myWords = new Set(v.myWords);
    paintFound(v);
    if (v.myFinished || v.race.status === "done") loadResults();
  }
  if (v.grid) $("board").classList.remove("blurred");
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- countdown (server-time synced) ----------
let cdInt = null;
function startCountdown(startsAt) {
  show("lobbyView");
  $("countdownOverlay").classList.remove("hidden");
  clearInterval(cdInt);
  const tick = () => {
    const left = Math.max(0, startsAt - (Date.now() + S.serverSkew));
    $("countdownNum").textContent = left > 4000 ? "5" : left > 3000 ? "4" : left > 2000 ? "3" : left > 1000 ? "2" : "1";
    if (left <= 0) { stopCountdown(); sync(); }
  };
  tick();
  cdInt = setInterval(tick, 200);
}
function stopCountdown() {
  clearInterval(cdInt);
  $("countdownOverlay").classList.add("hidden");
}

// ---------- board ----------
function buildBoard(grid) {
  if (S.grid && S.grid.join("") === grid.join("")) return;
  S.grid = grid;
  const b = $("board");
  b.innerHTML = "";
  b.classList.remove("blurred");
  grid.forEach((ch, i) => {
    const btn = document.createElement("button");
    btn.className = "cell";
    btn.textContent = ch;
    btn.dataset.i = i;
    b.appendChild(btn);
  });
}

function cellAt(i) { return $("board").children[i]; }
function adjacent(a, b) {
  const ar = Math.floor(a / 3), ac = a % 3, br = Math.floor(b / 3), bc = b % 3;
  return Math.max(Math.abs(ar - br), Math.abs(ac - bc)) === 1;
}

function paintPath() {
  [...$("board").children].forEach((c) => c.classList.remove("sel"));
  for (const i of S.path) cellAt(i).classList.add("sel");
  $("wordText").textContent = S.path.map((i) => S.grid[i]).join("");
}

let dragging = false;
let dragPointerId = null;
function cellFromPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  return el && el.closest ? el.closest(".cell") : null;
}
function pushCell(cell) {
  if (!cell) return;
  const i = Number(cell.dataset.i);
  if (S.path.includes(i)) {
    // backtrack to tapped cell
    S.path = S.path.slice(0, S.path.indexOf(i) + 1);
  } else if (S.path.length && adjacent(S.path[S.path.length - 1], i)) {
    S.path.push(i);
  }
  paintPath();
}
document.addEventListener("pointerdown", (e) => {
  const c = e.target.closest?.(".cell");
  if (!c || !S.grid || $("board").classList.contains("blurred")) return;
  e.preventDefault();
  dragging = true;
  dragPointerId = e.pointerId;
  S.path = [Number(c.dataset.i)];
  paintPath();
});
document.addEventListener("pointermove", (e) => {
  if (!dragging || (dragPointerId !== null && e.pointerId !== dragPointerId)) return;
  // elementFromPoint so finger-slides work on touch (no pointerover while touching).
  pushCell(cellFromPoint(e.clientX, e.clientY));
});
function endDrag(e) {
  if (!dragging || (e && dragPointerId !== null && e.pointerId !== dragPointerId)) return;
  dragging = false;
  dragPointerId = null;
  if (!S.grid) return;
  const w = S.path.map((i) => S.grid[i]).join("");
  S.path = [];
  paintPath();
  if (w.length >= 3) submitWord(w);
}
document.addEventListener("pointerup", endDrag);
document.addEventListener("pointercancel", () => { dragging = false; dragPointerId = null; S.path = []; paintPath(); });
$("clearBtn").onclick = () => { S.path = []; paintPath(); };

async function submitWord(w) {
  try {
    const r = await api(`/api/races/${S.raceId}/words`, {
      method: "POST",
      body: JSON.stringify({ playerId: S.playerId, word: w }),
    });
    if (!r.ok) {
      $("msg").textContent = r.reason === "already" ? "Already found" : r.reason === "not-in-list" ? "Not in word list" : r.reason === "no-path" ? "No path on grid" : r.reason;
      return;
    }
    $("msg").textContent = r.isBonus ? `${r.word} (bonus!)` : r.word;
    await sync();
    if (r.finished) { $("msg").textContent = `🏁 100% — waiting for the group…`; loadResults(); }
  } catch (e) { $("msg").textContent = e.message; }
}

function paintFound(v) {
  $("foundCount").textContent = v.myWords.length;
  $("foundList").innerHTML = [...v.myWords].sort().map((w) => `<li>${w}</li>`).join("");
}

$("giveUpBtn").onclick = async () => {
  if (!confirm("Give up? You'll be ranked last.")) return;
  await api(`/api/races/${S.raceId}/giveup`, { method: "POST", body: JSON.stringify({ playerId: S.playerId }) });
  await sync();
};

// ---------- live rank (acronyms only) + results ----------
function paintRank(order) {
  $("liveRank").innerHTML = order
    .map((p, i) => `<span class="chip ${i === 0 ? "lead" : ""} ${p.finished ? "done" : ""}">${i + 1}. ${escapeHtml(p.acronym)}${p.finished ? " 🏁" : ""}</span>`)
    .join('<span>›</span>');
}

async function loadResults() {
  try {
    const r = await api(`/api/races/${S.raceId}/results?playerId=${encodeURIComponent(S.playerId)}`);
    show("resultsView");
    if (S.grid) { /* keep race view accessible via back */ }
    show("resultsView");
    $("standings").innerHTML = r.standings
      .map((s) => `<li><b>${s.acronym}</b> ${escapeHtml(s.nickname)} — ${s.count}/${s.requiredTotal}${s.finishedMs != null ? ` in ${fmtMs(s.finishedMs)}` : s.gaveUp ? " (gave up)" : " (racing…)"}</li>`)
      .join("");
    $("hardest").innerHTML = r.hardest
      .map((h) => `<li><b>${h.word}</b> — found by ${h.foundBy}/${h.totalPlayers}${h.firstBy ? `, first: ${h.firstBy}` : ""}</li>`)
      .join("");
    const me = r.standings.find((s) => s.playerId === S.playerId);
    const won = me && me.rank === 1 && me.finishedMs != null;
    $("shareCard").textContent = won
      ? `👑 I have been crowned King of Squaredle Express ${r.date} in ${fmtMs(me.finishedMs)}! Dethrone me: ${location.origin}?room=${S.roomCode}`
      : `🏁 I finished ${ordinal(me?.rank)} in the Squaredle Express race ${r.date} (${me?.count}/${me?.requiredTotal}). Race us: ${location.origin}?room=${S.roomCode}`;
    // keep live board reachable: re-show race link
  } catch { /* not unlocked yet */ }
}
$("copyBtn").onclick = async () => {
  await navigator.clipboard.writeText($("shareCard").textContent).catch(() => {});
  $("copyBtn").textContent = "Copied!";
  setTimeout(() => ($("copyBtn").textContent = "Copy share text"), 1500);
};
function fmtMs(ms) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function ordinal(n) {
  if (!n) return "–";
  return n + (["th", "st", "nd", "rd"][n % 100 >= 11 && n % 100 <= 13 ? 0 : Math.min(n % 10, 4)] || "th");
}

// ---------- realtime: WS + polling fallback ----------
function connect() {
  try { S.ws?.close(); } catch {}
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws?raceId=${encodeURIComponent(S.raceId)}`);
  S.ws = ws;
  ws.onopen = () => { $("connDot").classList.add("on"); $("connText").textContent = "live"; };
  ws.onclose = () => { $("connDot").classList.remove("on"); $("connText").textContent = "reconnecting…"; };
  ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(ev.data);
      S.serverSkew = m.serverNow - Date.now();
      if (m.status === "countdown") startCountdown(m.startsAt);
      else stopCountdown();
      paintRank(m.order);
      sync().catch(() => {}); // refresh lobby/ready list, grid reveal, finish
    } catch {}
  };
  clearInterval(S.timer);
  S.timer = setInterval(() => {
    // Full refresh fallback (covers dropped sockets and lobby changes).
    sync().catch(() => {});
  }, 4000);
}

// ---------- admin ----------
$("adminLink").onclick = (e) => {
  e.preventDefault();
  show("adminView");
  api("/api/today").then((t) => {
    $("puzzleSource").textContent = `Today ${t.date}: ${t.requiredCount} required + ${t.bonusCount} bonus (source: ${t.source})`;
  });
};
$("adminFetch").onclick = async () => {
  $("adminMsg").textContent = "fetching official site…";
  try {
    const r = await api("/api/admin/fetch", { method: "POST", body: JSON.stringify({}) });
    $("adminMsg").textContent = `auto-fetch OK: grid=${r.puzzle.grid.join("")} words=${r.puzzle.required.length}`;
  } catch (e) { $("adminMsg").textContent = `auto-fetch failed: ${e.message} — paste manually below`; }
};
$("adminSave").onclick = async () => {
  const grid = $("adminGrid").value.trim().toUpperCase().split("");
  const required = $("adminRequired").value.split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  const bonus = $("adminBonus").value.split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  try {
    await api("/api/admin/puzzles", { method: "POST", body: JSON.stringify({ date: S.date || new Date().toISOString().slice(0, 10), grid, required, bonus }) });
    $("adminMsg").textContent = "saved ✓ (applies to lobby races; live races keep their grid)";
  } catch (e) { $("adminMsg").textContent = e.message; }
};

// auto-resume + ?room= invite links
const q = new URLSearchParams(location.search);
if (q.get("room")) { S.roomCode = q.get("room").toUpperCase(); $("roomCode").value = S.roomCode; }
if (S.playerId && S.raceId) { connect(); sync(); refreshKing(); }
