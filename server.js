'use strict';
/**
 * RT ZENE — chat + redeem-code desk.
 * Plain Node 22. No dependencies. Binds to 127.0.0.1 only.
 *
 *   node server.js              → http://127.0.0.1:5170
 *   PORT=8080 node server.js
 *
 * Admin passphrase comes from RTZENE_ADMIN_PASS (default 'rtzene' on first seed only).
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const db = require('./lib/db');

const PORT = Number(process.env.PORT || 5170);
const HOST = '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');

db.seed();

/* ----------------------------------------------------------------- helpers */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 256 * 1024) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/* --------------------------------------------------------------- SSE fanout */

const listeners = new Set();

function broadcast(event) {
  const frame = 'data: ' + JSON.stringify(event) + '\n\n';
  for (const res of listeners) {
    try { res.write(frame); } catch { listeners.delete(res); }
  }
}

/* ------------------------------------------------------------------ context */

function ctx(req) {
  const cookies = parseCookies(req);
  let token = cookies.rtzene_session;
  let user = db.sessionUser(token);

  // First visit: open the app as the owner so the demo starts inside RT ZENE.
  if (!user) {
    const owner = db.getUser('u_owner');
    if (owner) {
      token = db.createSession(owner.id);
      user = owner;
    }
  }
  return { token, user };
}

function setSession(res, token) {
  res.setHeader('set-cookie',
    `rtzene_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
}

/* -------------------------------------------------------------------- views */

function bootstrap(user) {
  const me = db.publicUser(user);
  return {
    me,
    chats: db.listChats(user.id),
    statuses: db.activeStatuses(),
    codes: db.listCodes(!!user.is_admin),
    my_redemptions: db.myRedemptions(user.id),
    stats: db.stats(),
    ledger: user.is_admin ? db.codeLedger() : [],
    people: db.db.prepare('SELECT * FROM users ORDER BY name').all().map(db.publicUser),
  };
}

/* ------------------------------------------------------------------- routes */

async function api(req, res, url) {
  const seg = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const { token, user } = ctx(req);
  if (!user) return json(res, 401, { error: 'no_session' });
  if (token) setSession(res, token);

  const method = req.method.toUpperCase();

  /* ---- session ---- */
  if (seg[0] === 'bootstrap' && method === 'GET') {
    return json(res, 200, bootstrap(user));
  }

  if (seg[0] === 'session' && method === 'GET') {
    return json(res, 200, { me: db.publicUser(user), people: db.db.prepare('SELECT * FROM users ORDER BY name').all().map(db.publicUser) });
  }

  if (seg[0] === 'session' && method === 'POST') {
    const body = await readBody(req);
    const target = body.handle === 'me' ? user : db.userByHandle(body.handle);
    if (!target) return json(res, 404, { error: 'unknown_handle' });
    const fresh = db.createSession(target.id);
    setSession(res, fresh);
    db.touchSeen(target.id);
    return json(res, 200, bootstrap(target));
  }

  /* ---- chats ---- */
  if (seg[0] === 'chats' && seg.length === 1 && method === 'GET') {
    return json(res, 200, { chats: db.listChats(user.id) });
  }

  if (seg[0] === 'chats' && seg[1] && seg[2] === 'messages' && method === 'GET') {
    const chat = db.db.prepare('SELECT * FROM chats WHERE id = ?').get(seg[1]);
    if (!chat) return json(res, 404, { error: 'no_chat' });
    const member = db.db.prepare('SELECT 1 AS n FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chat.id, user.id);
    if (!member) return json(res, 403, { error: 'not_a_member' });
    return json(res, 200, { messages: db.listMessages(chat.id, user.id) });
  }

  if (seg[0] === 'chats' && seg[1] && seg[2] === 'messages' && method === 'POST') {
    const body = await readBody(req);
    const text = String(body.body || '').trim().slice(0, 2000);
    if (!text) return json(res, 400, { error: 'empty' });
    const chat = db.db.prepare('SELECT * FROM chats WHERE id = ?').get(seg[1]);
    if (!chat) return json(res, 404, { error: 'no_chat' });
    const member = db.db.prepare(
      'SELECT 1 AS n FROM chat_members WHERE chat_id = ? AND user_id = ?'
    ).get(chat.id, user.id);
    if (!member) return json(res, 404, { error: 'no_chat' });
    const msg = db.createMessage({ chatId: chat.id, senderId: user.id, body: text });
    broadcast({ type: 'message', chat_id: chat.id, message_id: msg.id });
    return json(res, 200, { message: msg });
  }

  if (seg[0] === 'chats' && seg[1] === 'dm' && method === 'POST') {
    const body = await readBody(req);
    const target = db.userByHandle(body.handle);
    if (!target) return json(res, 404, { error: 'unknown_handle' });
    if (target.id === user.id) return json(res, 400, { error: 'self' });
    const id = db.getOrCreateDm(user.id, target.id);
    broadcast({ type: 'chat' });
    return json(res, 200, { chat_id: id });
  }

  if (seg[0] === 'chats' && seg[1] === 'group' && method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 40);
    if (!name) return json(res, 400, { error: 'no_name' });
    const ids = [user.id];
    for (const h of (body.handles || []).slice(0, 20)) {
      const u = db.userByHandle(h);
      if (u) ids.push(u.id);
    }
    const chatId = db.createGroup({ name, memberIds: ids });
    db.createMessage({ chatId, senderId: user.id, body: `${name} bana. Add: ${ids.length - 1} log.`, kind: 'system' });
    broadcast({ type: 'chat' });
    return json(res, 200, { chat_id: chatId });
  }

  if (seg[0] === 'chats' && seg[1] && seg[2] === 'pin' && method === 'POST') {
    const body = await readBody(req);
    db.db.prepare('UPDATE chats SET pinned = ? WHERE id = ?').run(body.pinned ? 1 : 0, seg[1]);
    return json(res, 200, { ok: true });
  }

  /* ---- status ---- */
  if (seg[0] === 'status' && method === 'POST') {
    const body = await readBody(req);
    const text = String(body.body || '').trim().slice(0, 700);
    if (!text) return json(res, 400, { error: 'empty' });
    db.createStatus(user.id, text);
    broadcast({ type: 'status' });
    return json(res, 200, { ok: true });
  }

  /* ---- redeem ---- */
  if (seg[0] === 'redeem' && method === 'POST') {
    const body = await readBody(req);
    const result = db.redeem({ codeText: body.code, userId: user.id, chatId: body.chat_id || null });
    if (result.ok) {
      broadcast({ type: 'redeem' });
      if (body.chat_id) {
        db.createMessage({
          chatId: body.chat_id, senderId: user.id,
          body: `${user.name} ne ${result.code} redeem kiya — ${result.reward}`,
          kind: 'system',
        });
      }
    }
    return json(res, result.ok ? 200 : 409, result);
  }

  /* ---- profile ---- */
  if (seg[0] === 'me' && method === 'POST') {
    const body = await readBody(req);
    const updated = db.updateUser(user.id, {
      name: String(body.name || '').trim().slice(0, 40) || undefined,
      about: String(body.about || '').trim().slice(0, 140) || undefined,
    });
    return json(res, 200, { me: db.publicUser(updated) });
  }

  /* ---- admin ---- */
  if (seg[0] === 'admin') {
    if (!user.is_admin) return json(res, 403, { error: 'admin_only' });

    if (seg[1] === 'codes' && seg.length === 2 && method === 'GET') {
      return json(res, 200, { codes: db.listCodes(true), ledger: db.codeLedger(), stats: db.stats() });
    }

    if (seg[1] === 'codes' && seg.length === 2 && method === 'POST') {
      const body = await readBody(req);
      const codeText = String(body.code || '').trim();
      const reward = String(body.reward || '').trim();
      if (!codeText) return json(res, 400, { error: 'no_code', message: 'Code likho.' });
      if (!reward) return json(res, 400, { error: 'no_reward', message: 'Reward likho.' });
      const dup = db.db.prepare('SELECT id FROM codes WHERE code = ?')
        .get(codeText.toUpperCase().replace(/\s+/g, '-'));
      if (dup) return json(res, 409, { error: 'duplicate', message: 'Ye code pehle se hai.' });
      const row = db.createCode({ ...body, userId: user.id });
      broadcast({ type: 'code' });
      return json(res, 200, { code: db.publicCode(row) });
    }

    if (seg[1] === 'codes' && seg[3] === 'active' && method === 'POST') {
      const body = await readBody(req);
      const row = db.setCodeActive(seg[2], !!body.active);
      broadcast({ type: 'code' });
      return json(res, 200, { code: row ? db.publicCode(row) : null });
    }

    if (seg[1] === 'codes' && seg[3] === 'send' && method === 'POST') {
      const body = await readBody(req);
      const msg = db.sendCodeToChat({ codeId: seg[2], chatId: body.chat_id, senderId: user.id });
      if (!msg) return json(res, 404, { error: 'no_code' });
      broadcast({ type: 'message', chat_id: body.chat_id, message_id: msg.id });
      return json(res, 200, { ok: true });
    }

    if (seg[1] === 'codes' && seg.length === 3 && method === 'DELETE') {
      db.deleteCode(seg[2]);
      broadcast({ type: 'code' });
      return json(res, 200, { ok: true });
    }
  }

  /* ---- live stream ---- */
  if (seg[0] === 'events' && method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    listeners.add(res);
    const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
    req.on('close', () => { clearInterval(beat); listeners.delete(res); });
    return;
  }

  if (seg[0] === 'passphrase' && method === 'POST') {
    const body = await readBody(req);
    const u = db.getUser(user.id);
    if (db.checkPass(String(body.pass || ''), u.payload)) {
      db.db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(u.id);
      return json(res, 200, { ok: true });
    }
    return json(res, 403, { ok: false, message: 'Galat passphrase.' });
  }

  return json(res, 404, { error: 'not_found', path: url.pathname });
}

/* ------------------------------------------------------------------ static */

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const full = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }

  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('404 — not here');
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': ext === '.woff2' ? 'public, max-age=604800' : 'no-cache',
    });
    fs.createReadStream(full).pipe(res);
  });
}

/* ------------------------------------------------------------------- server */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return serveStatic(req, res, url);
  } catch (err) {
    console.error('[rtzene]', req.method, url.pathname, err.message);
    json(res, 500, { error: 'server', message: err.message });
  }
});

server.listen(PORT, HOST, () => {
  const s = db.stats();
  console.log(`RT ZENE running → http://${HOST}:${PORT}`);
  console.log(`codes ${s.codes_total} · live ${s.codes_live} · redeemed ${s.redeemed} · messages ${s.messages}`);
  console.log('bound to loopback only. Ctrl+C to stop.');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const r of listeners) { try { r.end(); } catch {} }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 400).unref();
  });
}
