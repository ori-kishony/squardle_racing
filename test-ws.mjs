import WebSocket from "ws";
// Verifies the reported lobby bug: the FIRST joiner's socket must receive an
// update when a SECOND player joins (and when readiness changes).
const port = process.argv[2] || "3762";
const base = `http://localhost:${port}`;
async function join(roomCode, nickname) {
  return fetch(`${base}/api/rooms/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomCode, nickname }),
  }).then((r) => r.json());
}
const p1 = await join("WSLOBBY", "First");
const ws = new WebSocket(`ws://localhost:${port}/ws?raceId=${p1.raceId}&playerId=${p1.playerId}`);
const seen = [];
ws.on("message", (d) => seen.push(JSON.parse(d.toString())));
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("no initial snapshot")), 5000);
  ws.on("message", () => { clearTimeout(t); res(); }, { once: true });
  ws.on("error", rej);
});
const n0 = seen.length;
await join("WSLOBBY", "Second");
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("no broadcast after 2nd join")), 5000);
  const iv = setInterval(() => {
    if (seen.length > n0) { clearTimeout(t); clearInterval(iv); res(); }
  }, 100);
});
console.log(`ok: first joiner got live update on 2nd join (${seen.length} msgs)`);
ws.close();
process.exit(0);
