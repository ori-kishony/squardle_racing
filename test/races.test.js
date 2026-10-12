import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { puzzleDateAt, puzzleEndsAt } from '../src/calendar.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
test('real API: stale calendar, daily timeout, individual clocks and results', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'squaredle-races-'));
  const dbPath = join(dir, 'race.sqlite3');
  const officialPath = join(dir, 'official.json');
  writeFileSync(officialPath, JSON.stringify({date:'2026-10-08'}));
  const server = spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('../', import.meta.url),
    env: {...process.env, PORT:'0', DB_PATH:dbPath, OFFICIAL_TODAY_PATH:officialPath, NO_FETCH:'1'},
    stdio:['ignore','pipe','pipe'],
  });
  let logs = '';
  server.stdout.on('data', b => {logs += b;});
  server.stderr.on('data', b => {logs += b;});
  let db;
  try {
    for (let i = 0; i < 100 && !logs.includes('http://localhost:'); i++) await pause(50);
    const port = logs.match(/http:\/\/localhost:(\d+)/)?.[1];
    assert(port && port !== '0', logs);
    const base = `http://127.0.0.1:${port}`;
    const request = async (path, body, expected = 200) => {
      const r = await fetch(base + path, body ? {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body)} : {});
      const json = await r.json();
      assert.equal(r.status, expected, JSON.stringify(json));
      return json;
    };
    const joinPlayer = nickname => request('/api/rooms/join', {roomCode:'CLOCKS', nickname});
    const a = await joinPlayer('Anna');
    const b = await joinPlayer('Bob');
    assert.equal(a.date, puzzleDateAt()); // Thursday's stored pointer is ignored.
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 5000");
    const racePath = `/api/races/${a.raceId}`;
    const view = p => request(`${racePath}?playerId=${p.playerId}`);
    assert.equal((await view(a)).race.currentDate, puzzleDateAt());
    assert.equal((await fetch(base + '/api/today')).headers.get('cache-control'), 'no-store');
    await request(`${racePath}/start`, {playerId:a.playerId}, 409);
    for (const p of [a,b]) await request(`${racePath}/ready`, {playerId:p.playerId, ready:true});
    assert.equal((await view(a)).race.status, 'lobby');
    await request(`${racePath}/start`, {playerId:a.playerId});
    assert.equal((await view(a)).race.status, 'countdown');
    // A new player during countdown sends the group back to the lobby.
    const c = await joinPlayer('Countdown joiner');
    assert.equal((await view(a)).race.status, 'lobby');
    await request(`${racePath}/ready`, {playerId:c.playerId, ready:true});
    await request(`${racePath}/start`, {playerId:a.playerId});
    const original = Date.now() - 60000;
    db.prepare('UPDATE races SET starts_at = ? WHERE id = ?').run(original, a.raceId);
    assert.equal((await view(a)).race.status, 'live');
    assert.equal((await view(a)).myStartedAt, original);
    const late = await joinPlayer('Late racer');
    const lateStart = (await view(late)).myStartedAt;
    assert(lateStart > original + 59000);
    assert.equal((await joinPlayer('Late racer')).playerId, late.playerId);
    assert.equal((await view(late)).myStartedAt, lateStart); // Rejoining does not reset clock.
    for (const p of [a,b,c,late]) await request(`${racePath}/giveup`, {playerId:p.playerId});
    assert.equal((await view(a)).race.status, 'done');
    // A slower earlier finisher must not beat a faster late joiner.
    db.prepare('UPDATE race_players SET finished_at = ?, gave_up = 0 WHERE player_id = ?').run(original + 30000,a.playerId);
    db.prepare('INSERT INTO king_history (room_code,player_id,race_id,won_at) VALUES (?,?,?,?)').run('CLOCKS',a.playerId,a.raceId,original+30000);
    const after = await joinPlayer('After finish');
    assert.equal((await view(after)).race.status, 'live');
    await request(`${racePath}/results?playerId=${after.playerId}`, null, 403);
    const afterStart = (await view(after)).myStartedAt;
    for (const word of ['THE','HUG','RUG','LUG','HURT','EAT','TEA','HAT','LAT','GUR'])
      await request(`${racePath}/words`, {playerId:after.playerId,word});
    const results = await request(`${racePath}/results?playerId=${after.playerId}`);
    const me = results.standings.find(p => p.playerId === after.playerId);
    assert.equal(me.rank,1);
    assert.equal((await request('/api/rooms/CLOCKS/king')).king.playerId,after.playerId);
    assert(me.finishedMs >= 0 && me.finishedMs < 10000);
    assert.equal(me.finishedMs, db.prepare('SELECT finished_at FROM race_players WHERE player_id = ?').get(after.playerId).finished_at - afterStart);
    // Expire an unfinished old race, with the cutoff frozen in its results.
    const yesterday = new Date(Date.parse(`${a.date}T00:00:00Z`) - 86400000).toISOString().slice(0,10);
    db.prepare('INSERT INTO puzzles (date,grid,required,bonus,source) SELECT ?,grid,required,bonus,source FROM puzzles WHERE date = ?').run(yesterday,a.date);
    db.prepare('UPDATE races SET puzzle_date = ?, status = ?, starts_at = ? WHERE id = ?').run(yesterday, 'live', original - 86400000, a.raceId);
    db.prepare('UPDATE race_players SET finished_at = NULL, gave_up = 0, stopped_at = NULL WHERE player_id = ?').run(a.playerId);
    const expired = await view(a);
    assert.equal(expired.race.status,'done');
    assert.equal(expired.race.expired,true);
    assert.equal(expired.race.currentDate, a.date);
    assert.equal(db.prepare('SELECT stopped_at FROM race_players WHERE player_id = ?').get(a.playerId).stopped_at,puzzleEndsAt(yesterday));
    await request(`${racePath}/words`, {playerId:a.playerId,word:'THE'}, 409);
    const oldResults = await request(`${racePath}/results?playerId=${a.playerId}`);
    assert.equal(oldResults.standings.find(p => p.playerId === a.playerId).timedOut,true);
    const next = await joinPlayer('Anna');
    assert.notEqual(next.raceId,a.raceId);
    assert.equal(next.date,puzzleDateAt());
    assert.equal((await request(`/api/races/${next.raceId}?playerId=${next.playerId}`)).race.status,'lobby');
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      const exited = new Promise(resolve => server.once('exit',resolve));
      server.kill();
      await exited;
    }
    db?.close();
    rmSync(dir,{recursive:true,force:true});
  }
});
