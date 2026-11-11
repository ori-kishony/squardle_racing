import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { findPath, gridHintCounts, validateWord } from '../src/words.js';
import { puzzleDateAt, puzzleEndsAt } from '../src/calendar.js';

const grid = ['A','B','C','D','H','G','F','E','I','J','K','L','P','O','N',''];
const required = ['ABCD','ABCDE','ABCDEF','ABCDEFG','ABCDEFGHIJKL'];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('larger boards retain deterministic paths, holes, long words and hint counts', () => {
  assert.deepEqual(findPath(grid, required[4]), [0,1,2,3,7,6,5,4,8,9,10,11]);
  assert.equal(findPath(grid, 'LMN'), null); // Cannot traverse the blank at 15.
  assert.equal(findPath(grid, 'DHI'), null); // Cannot wrap rows.
  const counts = gridHintCounts(grid, required);
  assert.equal(counts.startCounts.length, 16);
  assert.equal(counts.startCounts[0], 5);
  assert.equal(counts.useCounts[15], 0);
  assert.equal(counts.useCounts.reduce((a,b) => a+b), required.reduce((sum,w) => sum+w.length,0));
  assert.equal(validateWord({grid, required, bonus:[], word:'ABC', alreadyFound:new Set(), minLength:4}).reason, 'too-short');
});

test('legacy database migrates atomically without losing IDs, progress or crowns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'squaredle-migration-'));
  const dbPath = join(dir,'legacy.sqlite3');
  let db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE puzzles(date TEXT PRIMARY KEY, grid TEXT NOT NULL, required TEXT NOT NULL, bonus TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT 'manual');
      CREATE TABLE rooms(code TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
      CREATE TABLE players(id TEXT PRIMARY KEY, room_code TEXT NOT NULL REFERENCES rooms(code), nickname TEXT NOT NULL, acronym TEXT NOT NULL, token TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE races(id TEXT PRIMARY KEY, room_code TEXT NOT NULL REFERENCES rooms(code), puzzle_date TEXT NOT NULL REFERENCES puzzles(date), status TEXT NOT NULL DEFAULT 'lobby', starts_at INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE race_players(race_id TEXT NOT NULL REFERENCES races(id), player_id TEXT NOT NULL REFERENCES players(id), ready INTEGER NOT NULL DEFAULT 0, finished_at INTEGER, gave_up INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(race_id,player_id));
      CREATE TABLE finds(race_id TEXT NOT NULL, player_id TEXT NOT NULL, word TEXT NOT NULL, found_at INTEGER NOT NULL, is_bonus INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(race_id,player_id,word));
      CREATE TABLE king_history(room_code TEXT NOT NULL, player_id TEXT NOT NULL, race_id TEXT NOT NULL, won_at INTEGER NOT NULL, PRIMARY KEY(room_code,race_id));
      INSERT INTO puzzles VALUES('2026-11-10','["T","E","T","A","H","R","L","U","G"]','["THE"]','[]','manual');
      INSERT INTO rooms VALUES('OLD','Old room',100);
      INSERT INTO players VALUES('player','OLD','Anna','A','token',100);
      INSERT INTO races VALUES('race','OLD','2026-11-10','done',100,100);
      INSERT INTO race_players VALUES('race','player',1,200,0);
      INSERT INTO finds VALUES('race','player','THE',200,0);
      INSERT INTO king_history VALUES('OLD','player','race',200);
    `);
    db.close(); db = null;
    const upgrade = () => execFileSync(process.execPath, ['--input-type=module','-e', `import {db} from './src/db.js'; db.close();`], {
      cwd: new URL('../',import.meta.url), env:{...process.env, DB_PATH:dbPath}, stdio:'pipe',
    });
    upgrade(); upgrade(); // Restart is idempotent.
    db = new DatabaseSync(dbPath);
    assert.equal(db.prepare('SELECT mode FROM puzzles').get().mode, 'express');
    assert.equal(db.prepare('SELECT mode FROM races').get().mode, 'express');
    assert.equal(db.prepare('SELECT started_at FROM race_players').get().started_at,100);
    assert.equal(db.prepare('SELECT finished_at FROM race_players').get().finished_at,200);
    assert.equal(db.prepare('SELECT word FROM finds').get().word,'THE');
    assert.equal(db.prepare('SELECT player_id FROM king_history').get().player_id,'player');
    assert.equal(db.prepare('SELECT token FROM players').get().token,'token');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    db.prepare('INSERT INTO puzzles VALUES(?,?,?,?,?,?)').run('2026-11-10','regular',JSON.stringify(grid),JSON.stringify(required),'[]','manual');
    db.prepare('INSERT INTO races(id,room_code,puzzle_date,mode,created_at) VALUES(?,?,?,?,?)').run('regular','OLD','2026-11-10','regular',300);
    assert.throws(() => db.prepare('INSERT INTO races(id,room_code,puzzle_date,mode,created_at) VALUES(?,?,?,?,?)').run('duplicate','OLD','2026-11-10','regular',300), /UNIQUE/);
    assert.throws(() => db.prepare('INSERT INTO races(id,room_code,puzzle_date,mode,created_at) VALUES(?,?,?,?,?)').run('missing','OLD','2026-11-09','regular',300), /FOREIGN KEY/);
  } finally { db?.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('Regular opens solo, resumes clocks, gates stats, separates modes and transfers crowns', async () => {
  const dir = mkdtempSync(join(tmpdir(),'squaredle-modes-'));
  const dbPath = join(dir,'race.sqlite3');
  const server = spawn(process.execPath,['src/server.js'], {
    cwd:new URL('../',import.meta.url), env:{...process.env, PORT:'0',DB_PATH:dbPath,NO_FETCH:'1'}, stdio:['ignore','pipe','pipe'],
  });
  let logs = '', db;
  server.stdout.on('data',b => logs += b);
  server.stderr.on('data',b => logs += b);
  try {
    for (let i=0;i<100 && !logs.includes('http://localhost:');i++) await pause(50);
    const port = logs.match(/http:\/\/localhost:(\d+)/)?.[1];
    assert(port,logs);
    const request = async (path, body, status=200) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`,body ? {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)} : {});
      const data = await response.json();
      assert.equal(response.status,status,JSON.stringify(data));
      return data;
    };
    const date = puzzleDateAt();
    await request('/api/today?mode=unknown',null,400);
    await request('/api/admin/puzzles',{date,mode:'regular',grid,required,bonus:['DCBA']});
    const joinPlayer = (nickname,mode) => request('/api/rooms/join',{roomCode:'MODES',nickname,mode});
    const a = await joinPlayer('Anna','regular');
    const exp = await joinPlayer('Anna'); // Defaults to Express, shared identity.
    assert.equal(exp.mode,'express');
    assert.equal(a.playerId,exp.playerId);
    assert.notEqual(a.raceId,exp.raceId);
    const view = p => request(`/api/races/${p.raceId}?playerId=${p.playerId}`);
    const v = await view(a);
    assert.equal(v.race.status,'live');
    assert.equal(v.race.mode,'regular');
    assert.deepEqual(v.grid,grid);
    assert.equal(v.faded.length,16);
    assert(v.myStartedAt > 0);
    assert.equal((await view(exp)).race.status,'lobby');
    assert.equal((await view(exp)).grid,null);
    await joinPlayer('Anna','regular');
    assert.equal((await view(a)).myStartedAt,v.myStartedAt);
    for (const action of ['ready','start']) await request(`/api/races/${a.raceId}/${action}`,{playerId:a.playerId,ready:true},409);
    await request(`/api/races/${a.raceId}/results?playerId=${a.playerId}`,null,403);
    const submit = (p,word) => request(`/api/races/${p.raceId}/words`,{playerId:p.playerId,word});
    assert.equal((await submit(a,'ABC')).reason,'too-short');
    assert.equal((await view(a)).myAccuracy,1);
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare('UPDATE race_players SET started_at = ? WHERE race_id = ? AND player_id = ?').run(Date.now()-60000,a.raceId,a.playerId);
    for (const word of required) assert((await submit(a,word)).ok);
    assert.equal((await view(a)).race.status,'done');
    assert.equal((await request('/api/rooms/MODES/king?mode=regular')).king.playerId,a.playerId);
    assert.equal((await request('/api/rooms/MODES/king')).king,null);
    const b = await joinPlayer('Bob','regular'); // Reopens done session for a late player.
    assert.equal((await view(b)).race.status,'live');
    await request(`/api/races/${b.raceId}/results?playerId=${b.playerId}`,null,403);
    const rank = await request(`/api/races/${b.raceId}/rank?playerId=${b.playerId}`);
    assert(rank.order.every(p => !('count' in p) && !('accuracy' in p)));
    assert.equal((await submit(b,'DCBA')).isBonus,true);
    for (const word of required) assert((await submit(b,word)).ok);
    const results = await request(`/api/races/${b.raceId}/results?playerId=${b.playerId}`);
    assert.equal(results.standings[0].playerId,b.playerId);
    assert.equal(results.standings[0].wins,1);
    assert.equal(results.standings.find(p=>p.playerId===a.playerId).wins,0);
    assert.equal((await request('/api/rooms/MODES/king?mode=regular')).king.playerId,b.playerId);
    assert.equal((await request('/api/rooms/MODES/king?mode=regular')).totalWins,1);
    assert.equal((await request('/api/rooms/MODES/king')).king,null);
    assert.equal((await view(exp)).requiredFound,0);
    // Crown an Express winner in the same room: neither totals nor monarch cross modes.
    const expBob = await joinPlayer('Bob','express');
    for (const p of [exp,expBob]) await request(`/api/races/${exp.raceId}/ready`,{playerId:p.playerId,ready:true});
    await request(`/api/races/${exp.raceId}/start`,{playerId:exp.playerId});
    db.prepare('UPDATE races SET starts_at = ? WHERE id = ?').run(Date.now()-10000,exp.raceId);
    for (const word of ['THE','HUG','RUG','LUG','HURT','EAT','TEA','HAT','LAT','GUR']) assert((await submit(exp,word)).ok);
    assert.equal((await request('/api/rooms/MODES/king')).king.playerId,exp.playerId);
    assert.equal((await request('/api/rooms/MODES/king')).totalWins,1);
    assert.equal((await request('/api/rooms/MODES/king?mode=regular')).king.playerId,b.playerId);
    const expResults = await request(`/api/races/${exp.raceId}/results?playerId=${exp.playerId}`);
    assert.equal(expResults.standings.find(p=>p.playerId===exp.playerId).wins,1);
    assert.equal(expResults.standings.find(p=>p.playerId===b.playerId).wins,0);
    assert.equal((await request(`/api/races/${b.raceId}/results?playerId=${a.playerId}`)).standings.find(p=>p.playerId===a.playerId).wins,0);

    const exHistory = await request('/api/rooms/MODES/history');
    const regHistory = await request('/api/rooms/MODES/history?mode=regular');
    assert.deepEqual(exHistory.races.map(r=>r.id),[exp.raceId]);
    assert.deepEqual(regHistory.races.map(r=>r.id),[a.raceId]);
    db.prepare('INSERT INTO word_definitions VALUES(?,?,?)').run(required[4],'A long test word.',Date.now());
    assert.equal((await request(`/api/races/${a.raceId}/definition?playerId=${a.playerId}&word=${required[4]}`)).definition,'A long test word.');
    await request('/api/admin/puzzles',{date,mode:'regular',grid,required,bonus:['DCBA']});
    assert.equal((await view(exp)).grid.length,9);
    const c = await joinPlayer('Carol','regular');
    await request(`/api/races/${c.raceId}/giveup`,{playerId:c.playerId});
    assert((await request(`/api/races/${c.raceId}/results?playerId=${c.playerId}`)).standings.find(p=>p.playerId===c.playerId).gaveUp);
    const d = await joinPlayer('Dan','regular');
    const yesterday = new Date(Date.parse(`${date}T00:00:00Z`)-86400000).toISOString().slice(0,10);
    db.prepare('INSERT INTO puzzles SELECT ?,mode,grid,required,bonus,source FROM puzzles WHERE date = ? AND mode = ?').run(yesterday,date,'regular');
    db.prepare('UPDATE races SET puzzle_date = ? WHERE id = ?').run(yesterday,a.raceId);
    assert((await view(d)).race.expired);
    assert.equal(db.prepare('SELECT stopped_at FROM race_players WHERE race_id = ? AND player_id = ?').get(a.raceId,d.playerId).stopped_at,puzzleEndsAt(yesterday));
    await request(`/api/races/${d.raceId}/words`,{playerId:d.playerId,word:required[0]},409);
    const next = await joinPlayer('Dan','regular');
    assert.notEqual(next.raceId,d.raceId);
    assert.equal((await view(next)).race.status,'live');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      const stopped = new Promise(resolve=>server.once('exit',resolve)); server.kill(); await stopped;
    }
    db?.close(); rmSync(dir,{recursive:true,force:true});
  }
});
