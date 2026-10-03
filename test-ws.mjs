import WebSocket from "ws";
const port = process.argv[2] || "3762";
const base = `http://localhost:${port}`;
const j = await fetch(`${base}/api/rooms/join`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ roomCode: "WSTEST", nickname: "Zed" }),
}).then((r) => r.json());
const ws = new WebSocket(`ws://localhost:${port}/ws?raceId=${j.raceId}&playerId=${j.playerId}`);
const msg = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("ws timeout")), 5000);
  ws.on("message", (d) => { clearTimeout(t); resolve(d.toString()); });
  ws.on("error", reject);
});
const m = JSON.parse(msg);
if (m.type !== "race" || !Array.isArray(m.order)) throw new Error("bad ws msg: " + msg);
console.log(`ok: ws live, status=${m.status} order=${m.order.map((o) => o.acronym).join(",")}`);
ws.close();
process.exit(0);
