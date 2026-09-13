const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8080);
const GAME_VERSION = '0.6.5.2';
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const USE_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
const DATA = path.join(__dirname, 'data.json');
const RESET_TTL_MS = 30 * 60 * 1000;
const sessions = new Map();


const STORE_PRODUCTS = [
  { id: 'cosmetic_commander_pass', type: 'cosmetic', title: 'Pase de comandante', priceUSD: 2.99 },
  { id: 'special_character_01', type: 'character_cosmetic', title: 'Personaje especial', priceUSD: 3.99 },
  { id: 'profile_insignia_pack', type: 'cosmetic', title: 'Paquete de insignias', priceUSD: 0.99 },
  { id: 'camouflage_pack_01', type: 'cosmetic', title: 'Camuflajes originales', priceUSD: 1.99 }
];

const DEFAULT_RESOURCES = {
  credits: 2500, iron: 1200, gold: 50, titanium: 0,
  rare_earths: 0, fuel: 700, energy: 300, construction: 900
};

async function loadDB() {
  if (!USE_SUPABASE) {
    if (!fs.existsSync(DATA)) return { users: [], resetTokens: [], clans: [], world: defaultWorld() };
    const db = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    db.users ||= []; db.resetTokens ||= []; db.clans ||= []; db.world ||= defaultWorld();
    return db;
  }
  const url = `${SUPABASE_URL}/rest/v1/game_state?id=eq.1&select=state`;
  const r = await fetch(url, { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } });
  if (!r.ok) throw new Error(`Supabase load failed: ${r.status}`);
  const rows = await r.json();
  if (!rows.length) {
    const initial = { users: [], resetTokens: [], clans: [], world: defaultWorld() };
    await saveDB(initial);
    return initial;
  }
  const db = rows[0].state || {};
  db.users ||= []; db.resetTokens ||= []; db.clans ||= []; db.world ||= defaultWorld();
  return db;
}
async function saveDB(db) {
  db.world ||= defaultWorld();
  if (!USE_SUPABASE) {
    const tmp = DATA + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DATA);
    return;
  }
  const url = `${SUPABASE_URL}/rest/v1/game_state`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ id: 1, state: db, updated_at: new Date().toISOString() })
  });
  if (!r.ok) throw new Error(`Supabase save failed: ${r.status}`);
}
function defaultWorld() {
  return { regions: [
    { id:'REGIÓN 001', owner:'NEUTRAL', control:0, credits:120, iron:80, fuel:40, energy:25 },
    { id:'REGIÓN 002', owner:'NEUTRAL', control:0, credits:160, iron:110, fuel:55, energy:30 },
    { id:'REGIÓN 003', owner:'ENEMIGO', control:0, credits:220, iron:150, fuel:70, energy:40 },
    { id:'REGIÓN 004', owner:'NEUTRAL', control:0, credits:180, iron:130, fuel:60, energy:35 },
    { id:'REGIÓN 005', owner:'ENEMIGO', control:0, credits:260, iron:190, fuel:80, energy:45 }
  ] };
}
function json(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(JSON.stringify(body));
}
function hash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function safeEqualHex(a, b) {
  try {
    const aa = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
  } catch (_) { return false; }
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
function publicUser(u) {
  return {
    id: u.id, email: u.email, name: u.name, level: u.level, xp: u.xp,
    resources: u.resources, region: u.region || 'REGIÓN 001', clanId: u.clanId || null,
    units: u.units, completedMissions: u.completedMissions || []
  };
}
function assignRegion(db, user) {
  const regions = [
    { id: 'REGIÓN 001', capacity: 100 },
    { id: 'REGIÓN 002', capacity: 100 },
    { id: 'REGIÓN 003', capacity: 100 }
  ];
  const counts = Object.fromEntries(regions.map(r => [r.id, 0]));
  for (const u of db.users) if (u.region && counts[u.region] !== undefined) counts[u.region]++;
  const region = regions.find(r => counts[r.id] < r.capacity) || regions[0];
  user.region = region.id;
  return region.id;
}
function authUser(req, db) {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7);
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  const user = db.users.find(u => u.id === session.userId);
  return user || null;
}
function requireAuth(req, res, db) {
  const user = authUser(req, db);
  if (!user) { json(res, 401, { error: 'unauthorized' }); return null; }
  return user;
}
function grantXp(user, amount) {
  user.xp += amount;
  while (user.xp >= 100) {
    user.xp -= 100;
    user.level += 1;
  }
}

// WebSocket de multijugador en tiempo real. La simulación crítica vive aquí,
// no en el teléfono: posiciones, HP, objetivo y tick son autoritativos del servidor.
const realtimeClients = new Set();
const realtimeRooms = new Map();
function wsFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
  else if (payload.length < 65536) {
    header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}
function wsSend(client, object) {
  if (client.socket.destroyed) return;
  try { client.socket.write(wsFrame(JSON.stringify(object))); } catch (_) {}
}
function wsClose(client) {
  try { client.socket.end(Buffer.from([0x88, 0x00])); } catch (_) {}
  realtimeClients.delete(client);
}
function wsBroadcast(roomId, object) {
  for (const client of realtimeClients) if (client.authed && client.roomId === roomId) wsSend(client, object);
}
function realtimeSnapshot(roomId) {
  const room = realtimeRooms.get(roomId);
  if (!room) return { type: 'world_snapshot', room: roomId, tick: 0, enemy_hp: 250, players: [] };
  return {
    type: 'world_snapshot', room: roomId, tick: room.tick, enemy_hp: Math.round(room.enemyHp),
    players: [...room.players.values()].map(p => ({ id:p.userId, name:p.name, x:Math.round(p.x), y:Math.round(p.y), hp:Math.round(p.hp), action:p.action }))
  };
}
function getRealtimeRoom(roomId) {
  if (!realtimeRooms.has(roomId)) realtimeRooms.set(roomId, { tick: 0, enemyHp: 250, resetAt: 0, players: new Map() });
  return realtimeRooms.get(roomId);
}
function parseWsFrames(client) {
  while (client.buffer.length >= 2) {
    const b0 = client.buffer[0], b1 = client.buffer[1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f, offset = 2;
    if (len === 126) { if (client.buffer.length < 4) return; len = client.buffer.readUInt16BE(2); offset = 4; }
    else if (len === 127) { if (client.buffer.length < 10) return; const n = client.buffer.readBigUInt64BE(2); if (n > BigInt(2 ** 31)) return wsClose(client); len = Number(n); offset = 10; }
    if (!masked) return wsClose(client);
    if (client.buffer.length < offset + 4 + len) return;
    const mask = client.buffer.subarray(offset, offset + 4); offset += 4;
    const payload = Buffer.from(client.buffer.subarray(offset, offset + len));
    client.buffer = client.buffer.subarray(offset + len);
    for (let i=0; i<payload.length; i++) payload[i] ^= mask[i % 4];
    if (opcode === 0x8) return wsClose(client);
    if (opcode === 0x9) { try { client.socket.write(Buffer.from([0x8A, payload.length])); } catch (_) {} continue; }
    if (opcode !== 0x1) continue;
    let msg; try { msg = JSON.parse(payload.toString('utf8')); } catch (_) { wsSend(client, {type:'error', message:'JSON inválido'}); continue; }
    realtimeMessage(client, msg);
  }
}
async function realtimeAuthenticate(client, msg) {
  const token = String(msg.token || '');
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) { sessions.delete(token); wsSend(client, {type:'error', message:'Sesión inválida o expirada'}); return false; }
  const db = await loadDB();
  const user = db.users.find(u => u.id === session.userId);
  if (!user) { wsSend(client, {type:'error', message:'Jugador no encontrado'}); return false; }
  const roomId = String(user.region || msg.region || 'REGIÓN 001');
  client.authed = true; client.userId = user.id; client.name = user.name; client.roomId = roomId;
  const room = getRealtimeRoom(roomId);
  room.players.set(user.id, { userId:user.id, name:user.name, x:120 + Math.random()*80, y:120 + Math.random()*180, hp:100, action:'EN ESPERA', velocity:0 });
  wsSend(client, {type:'auth_ok', userId:user.id, region:roomId, serverTime:Date.now()});
  wsSend(client, realtimeSnapshot(roomId));
  return true;
}
function realtimeMessage(client, msg) {
  if (String(msg.type || '') === 'auth') { realtimeAuthenticate(client, msg).catch(err => wsSend(client, {type:'error', message:'Error de autenticación del servidor'})); return; }
  if (!client.authed) { wsSend(client, {type:'error', message:'Autentica primero'}); return; }
  const room = getRealtimeRoom(client.roomId), p = room.players.get(client.userId);
  if (!p) return;
  if (String(msg.type || '') === 'order') {
    const action = String(msg.action || '');
    if (action === 'move') { p.action = 'AVANZANDO'; p.velocity = 35; }
    else if (action === 'attack') { p.action = 'ATACANDO'; p.velocity = 8; }
    else if (action === 'defend') { p.action = 'DEFENDIENDO'; p.velocity = 0; }
    else { wsSend(client, {type:'error', message:'Orden no reconocida'}); }
  }
}
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // Health debe responder sin depender de Supabase/JSON. Render y el cliente
    // usan este endpoint para despertar y comprobar el servicio.
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, game: 'Línea de Combate', version: GAME_VERSION, online: true, realtime: true, websocket: '/ws', persistence: USE_SUPABASE ? 'supabase' : 'local-json' });
    }

    const db = await loadDB();
    if (req.method === 'GET' && url.pathname === '/api/store/catalog') {
      return json(res, 200, { ok: true, currency: 'USD', products: STORE_PRODUCTS });
    }

    if (req.method === 'GET' && url.pathname === '/api/world/regions') {
      const ids = ['REGIÓN 001', 'REGIÓN 002', 'REGIÓN 003'];
      const regions = ids.map(id => ({ id, players: db.users.filter(u => u.region === id).length, capacity: 100 }));
      return json(res, 200, { ok: true, regions });
    }
    if (req.method !== 'GET' && req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
    const body = req.method === 'POST' ? await readBody(req) : {};

    if (req.method === 'POST' && url.pathname === '/api/auth/register') {
      const email = String(body.email || '').trim().toLowerCase();
      const name = String(body.name || '').trim();
      const password = String(body.password || '');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: 'invalid_email' });
      const commanderName = name || 'Comandante';
      if (commanderName.length > 32) return json(res, 400, { error: 'invalid_name' });
      if (password.length < 8) return json(res, 400, { error: 'weak_password' });
      if (db.users.some(u => u.email === email)) return json(res, 409, { error: 'email_exists' });
      const salt = crypto.randomBytes(16).toString('hex');
      const user = {
        id: crypto.randomUUID(), email, name: commanderName, salt,
        passwordHash: hash(password, salt), level: 1, xp: 0,
        resources: { ...DEFAULT_RESOURCES },
        units: { soldier: 12, sniper: 2, medic: 0, engineer: 1, heavy: 0, tank: 1, artillery: 0, aa: 0, drone: 0 },
        region: null, clanId: null, completedMissions: []
      };
      assignRegion(db, user);
      db.users.push(user); await saveDB(db);
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, { userId: user.id, expiresAt: Date.now() + 7 * 24 * 3600 * 1000 });
      return json(res, 201, { ok: true, token, user: publicUser(user) });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const identifier = String(body.identifier || body.email || '').trim();
      const email = identifier.toLowerCase();
      const password = String(body.password || '');
      const user = db.users.find(u => u.email === email || u.id === identifier);
      if (!user || !safeEqualHex(user.passwordHash, hash(password, user.salt))) return json(res, 401, { error: 'invalid_credentials' });
      if (!user.region) assignRegion(db, user);
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, { userId: user.id, expiresAt: Date.now() + 7 * 24 * 3600 * 1000 });
      await saveDB(db);
      return json(res, 200, { ok: true, token, user: publicUser(user) });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/forgot-password') {
      const email = String(body.email || '').trim().toLowerCase();
      const user = db.users.find(u => u.email === email);
      if (user) {
        const raw = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
        db.resetTokens = db.resetTokens.filter(t => t.expiresAt > Date.now() && t.userId !== user.id);
        db.resetTokens.push({ tokenHash, userId: user.id, expiresAt: Date.now() + RESET_TTL_MS });
        await saveDB(db);
        if (process.env.DEV_LOG_RESET_LINK === 'true') console.log('DEV RESET TOKEN:', raw);
      }
      return json(res, 200, { ok: true, message: 'Si el correo existe, recibirás un enlace de recuperación.' });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/reset-password') {
      const raw = String(body.token || '');
      const newPassword = String(body.password || '');
      if (newPassword.length < 8) return json(res, 400, { error: 'weak_password' });
      const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
      const entry = db.resetTokens.find(t => t.tokenHash === tokenHash && t.expiresAt > Date.now());
      if (!entry) return json(res, 400, { error: 'invalid_or_expired_token' });
      const user = db.users.find(u => u.id === entry.userId);
      if (!user) return json(res, 400, { error: 'invalid_or_expired_token' });
      user.salt = crypto.randomBytes(16).toString('hex');
      user.passwordHash = hash(newPassword, user.salt);
      db.resetTokens = db.resetTokens.filter(t => t !== entry);
      await saveDB(db);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/player/me') {
      const user = requireAuth(req, res, db); if (!user) return;
      return json(res, 200, { ok: true, user: publicUser(user) });
    }

    const missionMatch = url.pathname.match(/^\/api\/missions\/(001|002|003|004)\/complete$/);
    if (req.method === 'POST' && missionMatch && missionMatch[1] !== '001') {
      const user = requireAuth(req, res, db); if (!user) return;
      const mission = missionMatch[1];
      if ((user.completedMissions || []).includes(mission)) return json(res, 200, { ok:true, reward:{credits:0,iron:0,xp:0}, user:publicUser(user), alreadyCompleted:true });
      const rewards = { '002':{credits:750,iron:350,xp:160}, '003':{credits:1000,iron:500,xp:220}, '004':{credits:1250,iron:650,xp:300} };
      const reward = rewards[mission];
      user.resources.credits += reward.credits; user.resources.iron += reward.iron; grantXp(user, reward.xp);
      user.completedMissions ||= []; user.completedMissions.push(mission); await saveDB(db);
      return json(res, 200, { ok:true, reward, user:publicUser(user) });
    }
    if (req.method === 'POST' && url.pathname === '/api/missions/001/complete') {
      const user = requireAuth(req, res, db); if (!user) return;
      const mission = '001';
      // Server-authoritative reward. The client cannot choose the reward amount.
      const reward = { credits: 500, iron: 250, xp: 120 };
      user.resources.credits += reward.credits;
      user.resources.iron += reward.iron;
      grantXp(user, reward.xp);
      user.completedMissions ||= [];
      if (!user.completedMissions.includes(mission)) user.completedMissions.push(mission);
      await saveDB(db);
      return json(res, 200, { ok: true, reward, user: publicUser(user) });
    }

    if (req.method === 'GET' && url.pathname === '/api/world/state') {
      const user = requireAuth(req, res, db); if (!user) return;
      return json(res, 200, { ok: true, regions: db.world.regions });
    }
    if (req.method === 'POST' && url.pathname === '/api/world/collect') {
      const user = requireAuth(req, res, db); if (!user) return;
      const now = Date.now();
      if (user.lastWorldCollectAt && now - user.lastWorldCollectAt < 30000) return json(res, 429, { error:'collect_cooldown' });
      const controlled = db.world.regions.filter(r => r.owner === user.id);
      if (!controlled.length) return json(res, 400, { error:'no_controlled_region' });
      const reward = controlled.reduce((a,r) => ({ credits:a.credits+r.credits, iron:a.iron+r.iron, fuel:a.fuel+r.fuel, energy:a.energy+r.energy }), {credits:0,iron:0,fuel:0,energy:0});
      user.resources.credits += reward.credits; user.resources.iron += reward.iron; user.resources.fuel += reward.fuel; user.resources.energy += reward.energy;
      user.lastWorldCollectAt = now; await saveDB(db);
      return json(res, 200, { ok:true, reward, user:publicUser(user), regions:db.world.regions });
    }
    if (req.method === 'POST' && url.pathname === '/api/world/deploy') {
      const user = requireAuth(req, res, db); if (!user) return;
      const regionId = String(body.regionId || ''); const amount = Math.max(1, Math.min(50, Number(body.soldiers || 1)));
      const region = db.world.regions.find(r => r.id === regionId);
      if (!region) return json(res, 404, { error:'region_not_found' });
      if (user.units.soldier < amount || user.resources.fuel < amount * 10) return json(res, 400, { error:'insufficient_forces' });
      user.units.soldier -= amount; user.resources.fuel -= amount * 10;
      if (region.owner !== user.id) region.control = Math.min(100, Number(region.control || 0) + amount * 3);
      if (region.control >= 100) { region.owner = user.id; region.control = 100; }
      await saveDB(db);
      return json(res, 200, { ok:true, region, user:publicUser(user) });
    }
    if (req.method === 'POST' && url.pathname === '/api/clans/create') {
      const user = requireAuth(req, res, db); if (!user) return;
      const name = String(body.name || '').trim();
      if (name.length < 3 || name.length > 24) return json(res, 400, { error: 'invalid_clan_name' });
      if (user.clanId) return json(res, 409, { error: 'already_in_clan' });
      if (db.clans.some(c => c.name.toLowerCase() === name.toLowerCase())) return json(res, 409, { error: 'clan_exists' });
      const clan = { id: crypto.randomUUID(), name, leaderId: user.id, members: [{ userId: user.id, role: 'leader' }] };
      db.clans.push(clan); user.clanId = clan.id; await saveDB(db);
      return json(res, 201, { ok: true, clan });
    }

    if (req.method === 'POST' && url.pathname === '/api/clans/join') {
      const user = requireAuth(req, res, db); if (!user) return;
      const clanId = String(body.clanId || '');
      const clan = db.clans.find(c => c.id === clanId);
      if (!clan) return json(res, 404, { error: 'clan_not_found' });
      if (user.clanId) return json(res, 409, { error: 'already_in_clan' });
      clan.members.push({ userId: user.id, role: 'member' }); user.clanId = clan.id; await saveDB(db);
      return json(res, 200, { ok: true, clan });
    }

    if (req.method === 'GET' && url.pathname === '/api/clans') {
      return json(res, 200, { ok: true, clans: db.clans.map(c => ({ id: c.id, name: c.name, members: c.members.length })) });
    }

    return json(res, 404, { error: 'not_found' });
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: 'server_error' });
  }
});

server.on('upgrade', (req, socket) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    const client = { socket, buffer:Buffer.alloc(0), authed:false, userId:null, name:'', roomId:null };
    realtimeClients.add(client);
    socket.on('data', chunk => { client.buffer = Buffer.concat([client.buffer, chunk]); parseWsFrames(client); });
    socket.on('close', () => {
      realtimeClients.delete(client);
      if (client.authed && realtimeRooms.has(client.roomId)) realtimeRooms.get(client.roomId).players.delete(client.userId);
    });
    socket.on('error', () => realtimeClients.delete(client));
  } catch (_) { socket.destroy(); }
});
setInterval(() => {
  for (const [roomId, room] of realtimeRooms) {
    room.tick += 1;
    for (const p of room.players.values()) {
      if (p.velocity !== 0) {
        p.x += p.velocity * 0.1;
        if (p.x > 650) p.x = 650;
        if (p.x < 80) p.x = 80;
      }
      if (p.action === 'ATACANDO' && room.enemyHp > 0) room.enemyHp = Math.max(0, room.enemyHp - 1.2);
      if (room.enemyHp > 0 && p.action !== 'DEFENDIENDO') p.hp = Math.max(1, p.hp - 0.02);
    }
    if (room.enemyHp <= 0 && room.resetAt === 0) room.resetAt = Date.now() + 5000;
    if (room.resetAt > 0 && Date.now() >= room.resetAt) { room.enemyHp = 250; room.resetAt = 0; }
    if (room.players.size > 0) wsBroadcast(roomId, realtimeSnapshot(roomId));
    if (room.players.size === 0 && room.tick % 600 === 0) realtimeRooms.delete(roomId);
  }
}, 100);

server.listen(PORT, () => console.log(`Línea de Combate backend ${GAME_VERSION} escuchando en :${PORT}`));
