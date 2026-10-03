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
  myBonus: new Set(),
  requiredFound: 0,
  requiredTotal: 0,
  hints: null,
  faded: null,
  path: [],
  lastPath: [],
  timer: null,
  ws: null,
  serverSkew: 0,
  wordSort: "az",
  wordTab: "today",
  myWordsOrdered: [],
  lengthBreakdown: null,
  myAccuracy: 1,
  invalidGuesses: 0,
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
    if ($("raceView").classList.contains("hidden")) { S.wordTab = S.wordTab || "today"; }
    show("raceView");
    if (v.grid) buildBoard(v.grid);
    $("reqTotal").textContent = v.requiredCount;
    S.requiredTotal = v.requiredCount;
    S.requiredFound = v.requiredFound ?? v.myWords.length;
    S.myWords = new Set(v.myWords);
    S.myWordsOrdered = v.myWordsOrdered || v.myWords.map((w) => ({ word: w }));
    S.myBonus = new Set(v.myBonus || []);
    S.lengthBreakdown = v.lengthBreakdown || null;
    S.myAccuracy = v.myAccuracy ?? 1;
    S.invalidGuesses = v.invalidGuesses || 0;
    // "stale" = server predates the hints fields (needs `npm start` restart).
    S.hints = v.hints === undefined ? "stale" : v.hints;
    S.faded = v.faded || null;
    paintHints();
    paintWordList();
    paintProgress();
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

// ---------- board (original-style tiles + drag line) ----------
function buildBoard(grid) {
  if (S.grid && S.grid.join("") === grid.join("")) return;
  S.grid = grid;
  const b = $("board");
  b.innerHTML = "";
  b.classList.remove("blurred");
  grid.forEach((ch, i) => {
    const btn = document.createElement("button");
    btn.className = "cell";
    btn.dataset.i = i;
    const letter = document.createElement("span");
    letter.className = "letter";
    letter.textContent = ch;
    const start = document.createElement("span");
    start.className = "corner start";
    const use = document.createElement("span");
    use.className = "corner use";
    btn.append(letter, start, use);
    b.appendChild(btn);
  });
  requestAnimationFrame(redrawSvg);
}

function fmtCount(n) {
  if (!n) return "";
  return n >= 10 ? "+" : String(n);
}

// Progressive red/gray corner numbers + fade (mirror of the original perks).
function paintHints() {
  const cells = $("board").children;
  if (!cells.length) return;
  const h = S.hints;
  for (let i = 0; i < cells.length; i++) {
    const startEl = cells[i].querySelector(".corner.start");
    const useEl = cells[i].querySelector(".corner.use");
    if (startEl) startEl.textContent = h && h.startUnlocked && h.startCounts ? fmtCount(h.startCounts[i]) : "";
    if (useEl) useEl.textContent = h && h.useUnlocked && h.useCounts ? fmtCount(h.useCounts[i]) : "";
    cells[i].classList.toggle("faded", !!(S.faded && S.faded[i]));
  }
  if (!h) {
    $("hintNote").textContent = "";
  } else if (h === "stale") {
    $("hintNote").textContent = "Hints need the new server code — restart `npm start`.";
  } else if (!h.startUnlocked) {
    $("hintNote").textContent = `Find ${h.startAt} words to reveal starting-letter counts.`;
  } else if (!h.useUnlocked) {
    $("hintNote").textContent = `Find ${h.useAt} words to reveal tile-usage counts.`;
  } else {
    $("hintNote").textContent = "Red = words starting here · gray = words using this square.";
  }
}

function cellAt(i) { return $("board").children[i]; }
function adjacent(a, b) {
  const ar = Math.floor(a / 3), ac = a % 3, br = Math.floor(b / 3), bc = b % 3;
  return Math.max(Math.abs(ar - br), Math.abs(ac - bc)) === 1;
}

function cellCenter(i) {
  const box = $("boardBox").getBoundingClientRect();
  const r = cellAt(i).getBoundingClientRect();
  return { x: r.left - box.left + r.width / 2, y: r.top - box.top + r.height / 2 };
}

function redrawSvg() {
  const svg = $("dragSvg");
  const box = $("boardBox").getBoundingClientRect();
  svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
  svg.innerHTML = "";
  if (!S.path.length) return;
  const ns = "http://www.w3.org/2000/svg";
  const pts = S.path.map(cellCenter).map((p) => `${p.x},${p.y}`).join(" ");
  const line = document.createElementNS(ns, "polyline");
  line.setAttribute("points", pts);
  svg.appendChild(line);
  for (const p of S.path.map(cellCenter)) {
    const c = document.createElementNS(ns, "circle");
    c.setAttribute("cx", p.x);
    c.setAttribute("cy", p.y);
    c.setAttribute("r", 7);
    svg.appendChild(c);
  }
}

function paintPath() {
  [...$("board").children].forEach((c) => c.classList.remove("sel"));
  for (const i of S.path) cellAt(i).classList.add("sel");
  $("wordText").textContent = S.path.map((i) => S.grid[i]).join("");
  redrawSvg();
}
window.addEventListener("resize", () => redrawSvg());

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
  S.lastPath = [...S.path];
  S.path = [];
  paintPath();
  if (w.length >= 3) submitWord(w);
}
document.addEventListener("pointerup", endDrag);
document.addEventListener("pointercancel", () => { dragging = false; dragPointerId = null; S.path = []; paintPath(); });

let toastTimer = null;
function toast(text) {
  const m = $("msg");
  m.textContent = text;
  m.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => m.classList.add("hidden"), 1800);
}

function popCells(cells) {
  for (const i of cells) {
    const el = cellAt(i);
    if (!el) continue;
    el.classList.remove("pop");
    void el.offsetWidth;
    el.classList.add("pop");
  }
  setTimeout(() => {
    for (const i of cells) cellAt(i)?.classList.remove("pop");
  }, 500);
}

function shakeBoard() {
  const box = $("boardBox");
  box.classList.remove("shake");
  void box.offsetWidth;
  box.classList.add("shake");
}

async function submitWord(w) {
  try {
    const r = await api(`/api/races/${S.raceId}/words`, {
      method: "POST",
      body: JSON.stringify({ playerId: S.playerId, word: w }),
    });
    if (!r.ok) {
      shakeBoard();
      toast(r.reason === "already" ? "Already found" : r.reason === "not-in-list" ? "Not in word list" : r.reason === "no-path" ? "No path on grid" : r.reason);
      return;
    }
    popCells(S.lastPath);
    toast(r.isBonus ? `${r.word} (bonus!)` : r.word);
    await sync();
    if (r.finished) { toast(`🏁 100% — waiting for the group…`); loadResults(); }
  } catch (e) { toast(e.message); }
}

function paintProgress() {
  const found = S.requiredFound;
  const total = S.requiredTotal || "?";
  $("progressFound").textContent = found;
  $("progressTotal").textContent = total;
  const bar = $("starBar");
  bar.innerHTML = "";
  const frac = typeof total === "number" && total > 0 ? found / total : 0;
  for (let s = 0; s < 5; s++) {
    if (s > 0) {
      const seg = document.createElement("span");
      seg.className = "bar" + (frac >= (s + 0.5) / 5 ? " on" : "");
      bar.appendChild(seg);
    }
    const star = document.createElement("span");
    star.className = "star" + (frac >= (s + 0.5) / 5 ? " on" : "");
    star.textContent = "★";
    bar.appendChild(star);
  }
}

function fmtAcc(a) {
  return `${Math.round((a ?? 1) * 100)}%`;
}

function paintWordList() {
  $("foundCount").textContent = S.requiredFound;
  $("accChip").textContent = `🎯 ${fmtAcc(S.myAccuracy)}`;
  $("accChip").title = `Accuracy ${fmtAcc(S.myAccuracy)} — only invalid words hurt (${S.invalidGuesses || 0} misses)`;
  const isToday = (S.wordTab || "today") === "today";
  $("tabToday").classList.toggle("on", isToday);
  $("tabYesterday").classList.toggle("on", !isToday);
  $("sortAZ").classList.toggle("on", (S.wordSort || "az") === "az");
  $("sortFound").classList.toggle("on", S.wordSort === "found");
  $("foundGroups").classList.toggle("hidden", !isToday);
  $("lenSummary").classList.toggle("hidden", !isToday);
  $("yesterdayPane").classList.toggle("hidden", isToday);
  if (!isToday) { loadYesterday(); return; }
  // Missing-by-length: counts only, never the words (no spoiler while live).
  if (S.lengthBreakdown) {
    $("lenSummary").innerHTML = S.lengthBreakdown
      .map((g) => `<span class="lenChip${g.found >= g.total ? " done" : ""}">${g.len}L: ${g.found}/${g.total}</span>`)
      .join("");
  } else $("lenSummary").innerHTML = "";
  paintFound();
}

function paintFound() {
  const order = S.myWordsOrdered && S.myWordsOrdered.length ? S.myWordsOrdered : [...S.myWords].map((word) => ({ word }));
  const groups = new Map();
  for (const e of order) {
    const w = e.word;
    const len = w.length;
    if (!groups.has(len)) groups.set(len, []);
    groups.get(len).push(e);
  }
  const totals = new Map((S.lengthBreakdown || []).map((g) => [g.len, g.total]));
  const lens = [...new Set([...groups.keys(), ...totals.keys()])].sort((a, b) => a - b);
  const byFound = S.wordSort === "found";
  $("foundGroups").innerHTML = lens.length
    ? lens.map((len) => {
        let chips = groups.get(len) || [];
        if (!byFound) chips = [...chips].sort((a, b) => (a.word < b.word ? -1 : 1));
        const total = totals.get(len);
        const head = total != null ? `${len} letters — ${chips.length}/${total} (${Math.max(0, total - chips.length)} left)` : `${len} letters`;
        return `<div class="foundGroup"><h4>${head}</h4><div class="wordChips">${
          chips.length
            ? chips.map((e) => `<button class="wordChip ${S.myBonus.has(e.word) ? "bonus" : ""}" data-word="${e.word}">${e.word}</button>`).join("")
            : `<span class="hint">—</span>`
        }</div></div>`;
      }).join("")
    : `<p class="hint">Drag across letters to find words.</p>`;
}

// Tap a word → definition (free dictionary API, cached, Wiktionary fallback).
const defCache = new Map();
async function showDef(word) {
  const w = String(word || "").toUpperCase();
  $("defModal").classList.remove("hidden");
  $("defWord").textContent = w;
  if (defCache.has(w)) { $("defText").textContent = defCache.get(w); return; }
  $("defText").textContent = "Looking up…";
  try {
    const r = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${w.toLowerCase()}`);
    if (r.ok) {
      const j = await r.json();
      const d = j?.[0]?.meanings?.[0]?.definitions?.[0]?.definition;
      if (d) { defCache.set(w, d); $("defText").textContent = d; return; }
    }
    throw new Error("no dict entry");
  } catch {
    try {
      const r2 = await fetch(`https://en.wiktionary.org/api/rest_v1/page/definition/${w.toLowerCase()}`);
      if (r2.ok) {
        const j2 = await r2.json();
        const d2 = j2?.en?.[0]?.definitions?.[0]?.definition;
        const text = d2 ? String(d2).replace(/<[^>]+>/g, "") : "No definition found.";
        defCache.set(w, text); $("defText").textContent = text; return;
      }
    } catch { /* fall through */ }
    $("defText").textContent = "No definition found.";
  }
}
document.addEventListener("click", (e) => {
  const chip = e.target.closest?.(".wordChip[data-word]");
  if (chip) showDef(chip.dataset.word);
  if (e.target.closest?.("#defClose") || e.target.id === "defModal") $("defModal").classList.add("hidden");
});

$("tabToday").onclick = () => { S.wordTab = "today"; paintWordList(); };
$("tabYesterday").onclick = () => { S.wordTab = "yesterday"; paintWordList(); };
$("sortAZ").onclick = () => { S.wordSort = "az"; paintWordList(); };
$("sortFound").onclick = () => { S.wordSort = "found"; paintWordList(); };
$("tiebreakSel").onchange = () => loadResults(true);

async function loadYesterday() {
  const pane = $("yesterdayPane");
  pane.innerHTML = `<p class="hint">Loading yesterday…</p>`;
  try {
    const h = await api(`/api/rooms/${encodeURIComponent(S.roomCode)}/history?limit=7`);
    const past = (h.races || []).filter((r) => r.date !== S.date).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    if (!past) { pane.innerHTML = `<p class="hint">No yesterday race in this room yet.</p>`; return; }
    const r = await api(`/api/races/${past.id}/results?playerId=${encodeURIComponent(S.playerId)}`);
    const groups = new Map();
    for (const s of r.wordStats || []) {
      const len = s.word.length;
      if (!groups.has(len)) groups.set(len, []);
      groups.get(len).push(s);
    }
    pane.innerHTML = `<p class="hint">Yesterday ${r.date} — ${r.status}${r.standings?.length ? ` · 👑 ${escapeHtml(r.standings[0].nickname)}` : ""}</p>` +
      [...groups.keys()].sort((a, b) => a - b).map((len) =>
        `<div class="foundGroup"><h4>${len} letters (${groups.get(len).length})</h4><div class="wordChips">${
          groups.get(len).map((s) => `<button class="wordChip" data-word="${s.word}" title="found by ${s.foundBy}/${s.totalPlayers}">${s.word}</button>`).join("")
        }</div></div>`).join("");
  } catch (e) { pane.innerHTML = `<p class="hint">Yesterday locked until that race ends.</p>`; }
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

async function loadResults(force) {
  try {
    const tb = $("tiebreakSel") ? $("tiebreakSel").value : "";
    const r = await api(`/api/races/${S.raceId}/results?playerId=${encodeURIComponent(S.playerId)}${tb ? `&tiebreak=${encodeURIComponent(tb)}` : ""}`);
    show("resultsView");
    if (S.grid) { /* keep race view accessible via back */ }
    show("resultsView");
    $("standings").innerHTML = r.standings
      .map((s) => `<li><button class="linklike" data-acronym="${escapeHtml(s.acronym)}"><b>${s.rank}. ${s.acronym}</b></button> ${escapeHtml(s.nickname)} — ${s.count}/${s.requiredTotal} +${s.bonus || 0} bonus · 🎯 ${fmtAcc(s.accuracy)}${s.finishedMs != null ? ` in ${fmtMs(s.finishedMs)}` : s.gaveUp ? " (gave up)" : " (racing…)"}</li>`)
      .join("");
    $("hardest").innerHTML = r.hardest
      .map((h) => `<li><button class="wordChip" data-word="${h.word}">${h.word}</button> — found by ${h.foundBy}/${h.totalPlayers}${h.firstBy ? `, first: ${h.firstBy}` : ""}</li>`)
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
(async function resume() {
  if (!S.playerId || !S.raceId) return;
  try {
    // A stored race from a previous day stays pinned to its old puzzle.
    // Re-route to today's race when the dates no longer match.
    const [t, v] = await Promise.all([
      api("/api/today"),
      api(`/api/races/${S.raceId}?playerId=${encodeURIComponent(S.playerId)}`),
    ]);
    if (v.race.date !== t.date) {
      const j = await api("/api/rooms/join", {
        method: "POST",
        body: JSON.stringify({ roomCode: S.roomCode, nickname: S.nickname }),
      });
      S.playerId = j.playerId; S.raceId = j.raceId; S.date = j.date;
      store.set("playerId", S.playerId); store.set("raceId", S.raceId);
    }
  } catch { /* stored session invalid: user joins fresh via the form */ }
  connect();
  await sync().catch(() => {});
  await refreshKing();
})();
