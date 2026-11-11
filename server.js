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
/* Loopback by default so a phone preview is never exposed to the LAN. A host
   (Render, Fly, a tunnel) must opt in explicitly by setting HOST=0.0.0.0 —
   it is never the default, so a forgotten preview cannot leak. */
const HOST = process.env.HOST || '127.0.0.1';
const SELF_HOSTED = HOST !== '127.0.0.1';
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
  /* Secure on a public host so the cookie is never sent over plain HTTP there.
     Left off on loopback because a phone preview over http://127.0.0.1 would
     otherwise drop the cookie and look logged out. */
  res.setHeader('set-cookie',
    `rtzene_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${SELF_HOSTED ? '; Secure' : ''}`);
}

/* -------------------------------------------------------------------- views */

function bootstrap(user) {
  const me = db.publicUser(user);
  return {
    me,
    communities: db.listCommunities(user.id),
    chats: db.listChats(user.id),
    statuses: db.activeStatuses(),
    codes: user.is_admin ? db.listCodes(true) : db.listCodesForViewer(user.id),
    my_redemptions: db.myRedemptions(user.id),
    stats: db.stats(),
    wallet: db.payoutSummary(user.id),
    wallet_history: db.walletHistory(user.id),
    my_payouts: db.listPayouts(user.id),
    ledger: user.is_admin ? db.codeLedger() : [],
    all_payouts: user.is_admin ? db.listAllPayouts() : [],
    payout_rules: db.payoutRules(),
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

  /* ---- communities ---- */
  if (seg[0] === 'communities' && seg.length === 1 && method === 'GET') {
    return json(res, 200, { communities: db.listCommunities(user.id) });
  }
  if (seg[0] === 'communities' && seg[1] && seg.length === 2 && method === 'GET') {
    const com = db.getCommunity(seg[1], user.id);
    if (!com) return json(res, 404, { error: 'no_community' });
    return json(res, 200, { community: com });
  }
  /* ---- community codes: the owner adds them, members claim them ---- */
  const comId = seg[1];
  const role = seg[0] === 'communities' && comId ? db.communityRole(comId, user.id) : null;
  const canManageCom = role === 'owner' || role === 'admin' || user.is_admin;

  if (seg[0] === 'communities' && comId && seg[2] === 'codes' && seg.length === 3 && method === 'GET') {
    if (!role) return json(res, 404, { error: 'no_community' });
    return json(res, 200, {
      codes: db.listCodes(canManageCom, comId),
      rules: db.payoutRules(),
    });
  }
  if (seg[0] === 'communities' && comId && seg[2] === 'codes' && seg.length === 3 && method === 'POST') {
    if (!canManageCom) return json(res, 403, { error: 'owner_only', message: 'Sirf community owner code add kar sakta hai.' });
    const body = await readBody(req);
    const codeText = String(body.code || '').trim();
    const reward = String(body.reward || '').trim();
    if (!codeText) return json(res, 400, { error: 'no_code', message: 'Code likho.' });
    if (!reward) return json(res, 400, { error: 'no_reward', message: 'Reward likho.' });
    const value = Math.max(0, Math.round(Number(body.value) || 0));
    if (!value) return json(res, 400, { error: 'no_value', message: 'Is code se kitne rupaye wallet me jayenge, wo daalo.' });
    const dup = db.db.prepare('SELECT id FROM codes WHERE code = ?')
      .get(codeText.toUpperCase().replace(/\s+/g, '-'));
    if (dup) return json(res, 409, { error: 'duplicate', message: 'Ye code pehle se hai.' });
    const row = db.createCode({ ...body, value, userId: user.id, communityId: comId });
    broadcast({ type: 'code' });
    return json(res, 200, { code: db.publicCode(row) });
  }
  if (seg[0] === 'communities' && comId && seg[2] === 'codes' && seg[4] === 'active' && method === 'POST') {
    if (!canManageCom) return json(res, 403, { error: 'owner_only' });
    const body = await readBody(req);
    const row = db.setCodeActive(seg[3], !!body.active);
    broadcast({ type: 'code' });
    return json(res, 200, { code: row ? db.publicCode(row) : null });
  }
  if (seg[0] === 'communities' && comId && seg[2] === 'codes' && seg.length === 4 && method === 'DELETE') {
    if (!canManageCom) return json(res, 403, { error: 'owner_only' });
    db.deleteCode(seg[3]);
    broadcast({ type: 'code' });
    return json(res, 200, { ok: true });
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
    /* Announcements are admin-only. This is the real gate — the client also hides
       the composer, but a hidden input is not a permission. */
    const gate = db.canPost(chat.id, user.id);
    if (!gate.ok && gate.reason === 'announce_only') {
      return json(res, 403, { error: 'announce_only', message: 'Sirf admin announce kar sakta hai.' });
    }
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

  /* ---- wallet / payout requests ---- */
  if (seg[0] === 'wallet' && seg.length === 1 && method === 'GET') {
    return json(res, 200, {
      wallet: db.payoutSummary(user.id),
      history: db.walletHistory(user.id),
      payouts: db.listPayouts(user.id),
    });
  }
  if (seg[0] === 'wallet' && seg[1] === 'request' && method === 'POST') {
    const body = await readBody(req);
    const result = db.requestPayout({ userId: user.id, amount: body.amount, note: body.note });
    if (result.ok) broadcast({ type: 'payout' });
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

    /* ---- payouts: admin sees every request and delivers the Play code ---- */
    if (seg[1] === 'payouts' && seg.length === 2 && method === 'GET') {
      return json(res, 200, { payouts: db.listAllPayouts(), stats: db.payoutStats(), rules: db.payoutRules() });
    }
    if (seg[1] === 'payouts' && seg[2] && method === 'POST') {
      const body = await readBody(req);
      const result = db.decidePayout({
        payoutId: seg[2], action: body.action, codeText: body.code_text,
        adminNote: body.admin_note, adminId: user.id,
      });
      if (result.ok) broadcast({ type: 'payout' });
      return json(res, result.ok ? 200 : 409, result);
    }
    /* Payout rules: minimum, denomination step, delivery note. */
    if (seg[1] === 'payout-rules' && method === 'POST') {
      const body = await readBody(req);
      if (body.min_payout !== undefined) db.setSetting('min_payout', Math.max(1, Math.round(Number(body.min_payout) || 300)));
      if (body.payout_step !== undefined) db.setSetting('payout_step', Math.max(1, Math.round(Number(body.payout_step) || 100)));
      if (body.payout_note !== undefined) db.setSetting('payout_note', String(body.payout_note).slice(0, 140));
      broadcast({ type: 'payout' });
      return json(res, 200, { rules: db.payoutRules() });
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
  console.log(SELF_HOSTED
    ? `bound to ${HOST} — public host, HTTPS and real sign-in required.`
    : 'bound to loopback only. Ctrl+C to stop.');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const r of listeners) { try { r.end(); } catch {} }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 400).unref();
  });
}
