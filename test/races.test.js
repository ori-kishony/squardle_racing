import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { puzzleDateAt, puzzleEndsAt, nextPuzzleRefreshAt } from '../src/calendar.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
test('open-race sync discovers a published board even when both dates are cached', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'squaredle-publication-'));
  const statePath = join(dir, 'publisher.json');
  const date = puzzleDateAt();
  const nextDate = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const baseTime = Date.now();
  writeFileSync(statePath, JSON.stringify({date, time: baseTime}));
  const preload = join(dir, 'publisher.mjs');
  writeFileSync(preload, `
    import { readFileSync } from 'node:fs';
    const state = () => JSON.parse(readFileSync(${JSON.stringify(statePath)}, 'utf8'));
    Date.now = () => state().time;
    const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const encode = words => [...Buffer.from(words).toString('base64')].map(c => {
      const i = alpha.indexOf(c);
      return i < 0 ? c : alpha[(i + 12) % alpha.length];
    }).join('');
    globalThis.fetch = async url => {
      if (url.includes('today-puzzle-config')) {
        const puzzles = Object.fromEntries(${JSON.stringify([date, nextDate])}.map(date => [date.replaceAll('-', '/') + '-xp', {
          board: ['tet', 'ahr', 'lug'], wordScores: encode('the,hug,rug,lug,hurt'), optionalWordScores: '',
        }]));
        return new Response('const gPuzzleConfig = ' + JSON.stringify({puzzles}) + ';\\nconst gTodayDateStr = \\'' + state().date.replaceAll('-', '/') + '\\';');
      }
      if (url.includes('closure-')) return new Response('var e="' + alpha + '";f=function(r){var n=e.indexOf(r);return-1==n?r:e[(n-12+e.length)%e.length]}');
      if (url.includes('squaredle.app')) return new Response('<script src="/api/today-puzzle-config.js"></script><script src="closure-test.js"></script>');
      return new Response('{}', {status: 404});
    };
  `);
  const server = spawn(process.execPath, ['--import', preload, 'src/server.js'], {
    cwd: new URL('../', import.meta.url),
    env: {...process.env, PORT:'0', DB_PATH:join(dir, 'race.sqlite3'), OFFICIAL_TODAY_PATH:join(dir, 'official.json'), NO_FETCH:''},
    stdio:['ignore','pipe','pipe'],
  });
  let logs = '';
  server.stdout.on('data', b => {logs += b;});
  server.stderr.on('data', b => {logs += b;});
  try {
    for (let i = 0; i < 100 && !logs.includes('http://localhost:'); i++) await pause(50);
    const port = logs.match(/http:\/\/localhost:(\d+)/)?.[1];
    assert(port && port !== '0', logs);
    const base = `http://127.0.0.1:${port}`;
    const joinPlayer = async () => {
      const r = await fetch(base + '/api/rooms/join', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({roomCode:'PUBLISH', nickname:'Anna'})});
      assert.equal(r.status, 200);
      return r.json();
    };
    const a = await joinPlayer();
    assert.equal(a.date, date);
    // The official site publishes its next board ahead of our calendar.
    writeFileSync(statePath, JSON.stringify({date:nextDate, time:nextPuzzleRefreshAt(baseTime) + 1}));
    const view = await (await fetch(`${base}/api/races/${a.raceId}?playerId=${a.playerId}`)).json();
    assert.equal(view.race.date, date); // Existing race stays pinned.
    assert.equal(view.race.currentDate, nextDate); // Open tab can reroute.
    assert.equal((await (await fetch(base + '/api/today')).json()).date, nextDate);
    const b = await joinPlayer();
    assert.equal(b.date, nextDate);
    assert.notEqual(b.raceId, a.raceId);
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      const exited = new Promise(resolve => server.once('exit', resolve));
      server.kill();
      await exited;
    }
    rmSync(dir, {recursive:true, force:true});
  }
});
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
    db.prepare('INSERT OR REPLACE INTO word_definitions (word, definition, updated_at) VALUES (?, ?, ?)').run('THE', 'The definite article.', Date.now());
    db.prepare('INSERT OR REPLACE INTO word_definitions (word, definition, updated_at) VALUES (?, ?, ?)').run('UGH', 'An expression of disgust.', Date.now());
    await request(`${racePath}/definition?playerId=${c.playerId}&word=THE`, null, 403);
    await request(`${racePath}/results?playerId=${a.playerId}`, null, 403);
    const submit = (p, word) => request(`${racePath}/words`, {playerId:p.playerId, word});
    assert.equal((await submit(a, 'hurt')).firstInRoom, true);
    assert.equal((await submit(b, 'HURT')).firstInRoom, false);
    const duplicate = await submit(a, 'HURT');
    assert.equal(duplicate.reason, 'already');
    assert.equal(duplicate.firstInRoom, undefined);
    const invalid = await submit(c, 'ZZZZ');
    assert.equal(invalid.ok, false);
    assert.equal(invalid.firstInRoom, undefined);
    for (const [p, words] of [[a, ['UGH', 'LUR', 'RUA', 'RUL']], [b, ['UGH', 'LUR']], [c, ['UGH']]]) {
      for (const word of words) assert.equal((await submit(p, word)).firstInRoom, p === a);
    }
    const late = await joinPlayer('Late racer');
    const lateStart = (await view(late)).myStartedAt;
    assert(lateStart > original + 59000);
    assert.equal((await joinPlayer('Late racer')).playerId, late.playerId);
    assert.equal((await view(late)).myStartedAt, lateStart); // Rejoining does not reset clock.
    for (const p of [a,b,c,late]) await request(`${racePath}/giveup`, {playerId:p.playerId});
    assert.equal((await view(a)).race.status, 'done');
    // A slow outlier affects average difficulty more than median difficulty.
    for (const [i, p] of [a,b,c,late].entries()) {
      const started = db.prepare('SELECT started_at FROM race_players WHERE race_id = ? AND player_id = ?').get(a.raceId, p.playerId).started_at;
      db.prepare('INSERT INTO finds VALUES (?, ?, ?, ?, 0)').run(a.raceId, p.playerId, 'THE', started + [1000,2000,3000,54000][i]);
    }
    const bonusResults = await request(`${racePath}/results?playerId=${a.playerId}`);
    const theStats = bonusResults.wordStats.find(w => w.word === 'THE');
    assert.equal(theStats.avgMs, 15000);
    assert.equal(theStats.medianMs, 2500);
    const missingTimes = db.prepare('SELECT stopped_at - started_at AS elapsed FROM race_players WHERE race_id = ?').all(a.raceId).map(p => p.elapsed).sort((a,b) => a-b);
    const eatStats = bonusResults.wordStats.find(w => w.word === 'EAT');
    assert.equal(eatStats.foundBy, 0);
    assert.equal(eatStats.medianMs, Math.round((missingTimes[1] + missingTimes[2]) / 2));
    assert.equal(bonusResults.wordStats.find(w => w.word === 'HURT').firstBy, 'Anna');
    // Results allow definitions even for words this player never found.
    assert((await request(`${racePath}/definition?playerId=${late.playerId}&word=THE`)).definition.length > 0);
    assert((await request(`${racePath}/definition?playerId=${late.playerId}&word=UGH`)).definition.length > 0);
    await request(`${racePath}/definition?playerId=outsider&word=THE`, null, 403);
    await request(`${racePath}/definition?playerId=${late.playerId}&word=ZZZZ`, null, 403);
    assert.deepEqual(bonusResults.popularBonus, [
      {word:'UGH', foundBy:3, totalPlayers:4},
      {word:'LUR', foundBy:2, totalPlayers:4},
      {word:'RUA', foundBy:1, totalPlayers:4},
    ]);
    const other = await request('/api/rooms/join', {roomCode:'OTHER', nickname:'Other racer'});
    const otherPeer = await request('/api/rooms/join', {roomCode:'OTHER', nickname:'Other peer'});
    await request(`/api/races/${other.raceId}/ready`, {playerId:other.playerId, ready:true});
    await request(`/api/races/${other.raceId}/ready`, {playerId:otherPeer.playerId, ready:true});
    await request(`/api/races/${other.raceId}/start`, {playerId:other.playerId});
    db.prepare('UPDATE races SET starts_at = ? WHERE id = ?').run(original, other.raceId);
    assert.equal((await request(`/api/races/${other.raceId}/words`, {playerId:other.playerId, word:'HURT'})).firstInRoom, true);
    await request(`/api/races/${other.raceId}/giveup`, {playerId:other.playerId});
    assert.deepEqual((await request(`/api/races/${other.raceId}/results?playerId=${other.playerId}`)).popularBonus, []);
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
    const fiveTimes = db.prepare("SELECT f.found_at - rp.started_at AS elapsed FROM finds f JOIN race_players rp ON rp.race_id = f.race_id AND rp.player_id = f.player_id WHERE f.race_id = ? AND f.word = 'THE'").all(a.raceId).map(p => p.elapsed).sort((a,b) => a-b);
    assert.equal(fiveTimes.length, 5);
    assert.equal(results.wordStats.find(w => w.word === 'THE').medianMs, fiveTimes[2]);
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
