'use strict';
const TICK = 20, SQUAD_SIZE = 4, MAX_SQUADS = 5, MIN_PLAYERS = 2, COUNTDOWN = 15, MAX_SPEED = 12;
const CENTER = { x: -58, z: 95 };
const r2 = v => Math.round(v * 100) / 100;

function spawnFor(i) {
  const a = (i % 8) / 8 * Math.PI * 2;
  return { x: CENTER.x + 230 * Math.cos(a), z: CENTER.z + 140 * Math.sin(a) };
}

class Room {
  constructor(id, onEmpty) {
    this.id = id; this.onEmpty = onEmpty;
    this.players = new Map(); this.squads = new Map();
    this.state = 'waiting'; this.cdEnd = 0; this.k = 0; this.nextId = 1; this.nextSpawn = 0; this.autoN = 0;
    this.timer = setInterval(() => this.tick(), 1000 / TICK);
  }
  canAccept(code) {
    if (this.state !== 'waiting') return false;
    if (code) {
      const s = this.squads.get(code);
      return s ? s.members.size < SQUAD_SIZE : this.squads.size < MAX_SQUADS;
    }
    for (const s of this.squads.values()) if (s.auto && s.members.size < SQUAD_SIZE) return true;
    return this.squads.size < MAX_SQUADS;
  }
  add(ws, name, code) {
    let s;
    if (code) s = this.squads.get(code) || this.newSquad(code, false);
    else s = [...this.squads.values()].find(x => x.auto && x.members.size < SQUAD_SIZE) || this.newSquad('#' + (++this.autoN), true);
    const base = spawnFor(s.spawnIdx), a = s.members.size * Math.PI / 2;
    const p = { id: this.nextId++, name, ws, room: this, squad: s.code,
      x: base.x + 3 * Math.cos(a), y: null, z: base.z + 3 * Math.sin(a), yaw: 0, lastIn: Date.now() };
    s.members.add(p.id); this.players.set(p.id, p);
    this.send(p, { t: 'welcome', id: p.id, room: this.id, squad: p.squad, spawn: { x: p.x, z: p.z }, state: this.state,
      players: [...this.players.values()].map(q => ({ id: q.id, name: q.name, squad: q.squad })) });
    this.broadcast({ t: 'join', p: { id: p.id, name: p.name, squad: p.squad } }, p);
    return p;
  }
  newSquad(code, auto) {
    const s = { code, auto, members: new Set(), spawnIdx: this.nextSpawn++ };
    this.squads.set(code, s); return s;
  }
  onMessage(p, m) {
    if (m.t !== 'in') return;
    const { x, y, z, yaw } = m;
    if (![x, y, z, yaw].every(Number.isFinite)) return;
    const now = Date.now(), dt = Math.max((now - p.lastIn) / 1000, 0.05);
    p.lastIn = now;
    if (Math.hypot(x - p.x, z - p.z) > MAX_SPEED * dt + 2 || (p.y !== null && Math.abs(y - p.y) > 50 * dt + 3)) {
      this.send(p, { t: 'fix', x: p.x, y: p.y === null ? y : p.y, z: p.z }); return;
    }
    p.x = x; p.y = y; p.z = z; p.yaw = yaw;
  }
  leave(p) {
    if (!this.players.delete(p.id)) return;
    const s = this.squads.get(p.squad);
    if (s) { s.members.delete(p.id); if (!s.members.size) this.squads.delete(s.code); }
    this.broadcast({ t: 'leave', id: p.id });
    if (!this.players.size) { clearInterval(this.timer); this.onEmpty(); }
  }
  tick() {
    this.k++;
    if (this.state === 'waiting') {
      if (this.players.size >= MIN_PLAYERS) {
        if (!this.cdEnd) this.cdEnd = Date.now() + COUNTDOWN * 1000;
        else if (Date.now() >= this.cdEnd) { this.state = 'playing'; this.cdEnd = 0; this.broadcast({ t: 'state', st: 'playing' }); }
      } else this.cdEnd = 0;
    }
    const msg = JSON.stringify({ t: 's', k: this.k, st: this.state, n: this.players.size,
      cd: this.cdEnd ? Math.ceil((this.cdEnd - Date.now()) / 1000) : -1,
      p: [...this.players.values()].map(q => [q.id, r2(q.x), r2(q.y === null ? 0 : q.y), r2(q.z), r2(q.yaw)]) });
    for (const q of this.players.values()) if (q.ws.readyState === 1) q.ws.send(msg);
  }
  send(p, o) { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(o)); }
  broadcast(o, except) {
    const msg = JSON.stringify(o);
    for (const q of this.players.values()) if (q !== except && q.ws.readyState === 1) q.ws.send(msg);
  }
}

class Matchmaker {
  constructor() { this.rooms = new Map(); this.n = 0; }
  join(ws, m) {
    const name = String(m.name || 'Player').replace(/[^\w \-]/g, '').slice(0, 16) || 'Player';
    const code = String(m.squad || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    const all = [...this.rooms.values()];
    let room = (code && all.find(r => r.squads.has(code) && r.canAccept(code))) || all.find(r => r.canAccept(code));
    if (!room) {
      const id = ++this.n;
      room = new Room(id, () => this.rooms.delete(id));
      this.rooms.set(id, room);
    }
    return room.add(ws, name, code);
  }
}

module.exports = { Matchmaker, Room };
