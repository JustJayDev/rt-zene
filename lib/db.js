'use strict';
/**
 * RT ZENE — data layer.
 * Built on node:sqlite (Node 22 built-in). No dependencies.
 */

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = process.env.RTZENE_DATA || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'rtzene.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  handle      TEXT NOT NULL UNIQUE,
  about       TEXT NOT NULL DEFAULT 'Hey there! I am on RT ZENE.',
  hue         INTEGER NOT NULL,
  is_admin    INTEGER NOT NULL DEFAULT 0,
  payload     TEXT NOT NULL DEFAULT '',   -- passphrase hash for admin
  last_seen   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,              -- 'dm' | 'group'
  name        TEXT,                       -- groups only
  hue         INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  pinned      INTEGER NOT NULL DEFAULT 0,
  muted       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at   INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_id   TEXT NOT NULL REFERENCES users(id),
  body        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'text',   -- 'text' | 'code' | 'system'
  code        TEXT,
  created_at  INTEGER NOT NULL,
  delivered   INTEGER NOT NULL DEFAULT 0,
  read_at     INTEGER
);

CREATE TABLE IF NOT EXISTS statuses (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS codes (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  reward      TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  max_uses    INTEGER NOT NULL DEFAULT 1,
  uses        INTEGER NOT NULL DEFAULT 0,
  expires_at  INTEGER,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS redemptions (
  id          TEXT PRIMARY KEY,
  code_id     TEXT NOT NULL REFERENCES codes(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id     TEXT,
  at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_msg_chat  ON messages(chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_red_code  ON redemptions(code_id);
CREATE INDEX IF NOT EXISTS idx_red_user  ON redemptions(user_id);
`);

const now = () => Date.now();
const uid = (p) => p + '_' + crypto.randomBytes(9).toString('base64url');

/* ---------------------------------------------------------------- seeding */

function seed() {
  const has = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (has > 0) return;

  const insertUser = db.prepare(
    'INSERT INTO users (id,name,handle,about,hue,is_admin,payload,last_seen) VALUES (?,?,?,?,?,?,?,?)'
  );
  const people = [
    ['u_owner', 'Jay',   'jay',    'Redeem codes roz shaam 8 baje.', 42, 1, hashPass(process.env.RTZENE_ADMIN_PASS || 'rtzene'), now()],
    ['u_ava',   'Ava',   'ava',    'Headshot ya kuch nahi.',          158, 0, '', now() - 62_000],
    ['u_ravi',  'Ravi',  'ravi',   'Squad me rehna.',                268, 0, '', now() - 11 * 60_000],
    ['u_neha',  'Neha',  'neha',   'Clutch queen.',                   18, 0, '', now() - 3 * 3600_000],
    ['u_arjun', 'Arjun', 'arjun',  'Lone wolf.',                    210, 0, '', now() - 26 * 3600_000],
  ];
  for (const p of people) insertUser.run(...p);

  const insertChat = db.prepare(
    'INSERT INTO chats (id,kind,name,hue,created_at,pinned) VALUES (?,?,?,?,?,?)'
  );
  const insertMember = db.prepare(
    'INSERT INTO chat_members (chat_id,user_id,joined_at) VALUES (?,?,?)'
  );
  const chats = [
    ['c_ava',   'dm',    null,            158, 0],
    ['c_ravi',  'dm',    null,            268, 0],
    ['c_squad', 'group', 'TQG Squad',      42, 1],
    ['c_neha',  'dm',    null,             18, 0],
    ['c_arjun', 'dm',    null,            210, 0],
  ];
  for (const [id, kind, name, hue, pinned] of chats) {
    insertChat.run(id, kind, name, hue, now(), pinned);
    insertMember.run(id, 'u_owner', now());
  }
  for (const [chat, mate] of [['c_ava','u_ava'],['c_ravi','u_ravi'],['c_neha','u_neha'],['c_arjun','u_arjun']]) {
    insertMember.run(chat, mate, now());
  }
  for (const mate of ['u_ava','u_ravi','u_neha','u_arjun']) insertMember.run('c_squad', mate, now());

  const insertMsg = db.prepare(
    'INSERT INTO messages (id,chat_id,sender_id,body,kind,code,created_at,delivered,read_at) VALUES (?,?,?,?,?,?,?,?,?)'
  );
  const m = (chat, from, body, minsAgo, kind = 'text', code = null, read = 1) =>
    insertMsg.run(uid('m'), chat, from, body, kind, code, now() - minsAgo * 60_000, 1, read ? now() - minsAgo * 60_000 + 8000 : null);

  m('c_ava', 'u_ava',  'Bhai aaj custom room hai kya?', 46);
  m('c_ava', 'u_owner','Haan 9 baje. Link bhej dunga.', 44);
  m('c_ava', 'u_ava',  'Perfect. Squad ko bhi bol deti hu.', 43);
  m('c_ava', 'u_owner','Ye le, aaj ka drop.', 13);
  insertMsg.run(uid('m'), 'c_ava', 'u_owner', 'RTZENE-9X4K-2P7Q', 'code', 'RTZENE-9X4K-2P7Q', now() - 12 * 60_000, 1, now() - 11 * 60_000);

  m('c_ravi', 'u_owner', 'Code bhej diya, check kar lo.', 300);
  m('c_ravi', 'u_ravi',  'Mil gaya bhai, thanks. Aaj ka scrim bhi le lena.', 298);
  m('c_ravi', 'u_ravi',  'Kal wala room bhi rakhna.', 190);

  m('c_squad', 'u_arjun', 'Kal ka scrim 7:30 pe shift ho gaya.', 21);
  m('c_squad', 'u_neha',  'Theek hai, main time pe aa jaungi.', 19);
  m('c_squad', 'u_owner', 'Sab log 7:15 pe online ho jao.', 16);

  m('c_neha', 'u_neha',  'Ye naya app kya hai?', 520);
  m('c_neha', 'u_owner', 'RT ZENE. Chat plus redeem codes.', 515, 'text', null, 0);

  m('c_arjun','u_owner', 'Codes tab kholo, wahan likha hai.', 1500);
  m('c_arjun','u_arjun', 'Mil gaya. Aaj shaam 8 baje wala drop hai?', 96, 'text', null, 0);

  const insertStatus = db.prepare(
    'INSERT INTO statuses (id,user_id,body,created_at,expires_at) VALUES (?,?,?,?,?)'
  );
  const st = (u, body, minsAgo) =>
    insertStatus.run(uid('s'), u, body, now() - minsAgo * 60_000, now() + (24 * 60 - minsAgo) * 60_000);
  st('u_ava',  'Rank push chal raha hai, wish me luck.', 40);
  st('u_ravi', 'Naya sensitivity try kiya, fark pad gaya.', 180);
  st('u_neha', 'Aaj ka last match. GG all.', 300);

  const insertCode = db.prepare(
    'INSERT INTO codes (id,code,reward,note,max_uses,uses,expires_at,active,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
  );
  const insertClaim = db.prepare(
    'INSERT INTO redemptions (id,code_id,user_id,chat_id,at) VALUES (?,?,?,?,?)'
  );
  /* Seeded codes carry REAL ledger rows, not just a uses counter — otherwise the
     list says "used up" while the meter says "0 of 3". */
  const c = (code, reward, note, max, claimers, hrs) => {
    const id = uid('k');
    insertCode.run(id, code, reward, note, max, claimers.length, now() + hrs * 3600_000, 1, now() - 3600_000);
    claimers.forEach((u, i) => insertClaim.run(uid('r'), id, u, null, now() - (90 - i * 7) * 60_000));
  };
  c('RTZENE-9X4K-2P7Q', '1000 UC',     'Squad room giveaway',  1, ['u_ava'], 20);
  c('RTZENE-7H2M-5R9T', '500 UC',      'Status reply ke liye', 5, ['u_ravi', 'u_neha'], 48);
  c('RTZENE-3W8N-1J6B', 'Diamond 310', 'Weekly drop',         20, ['u_ava', 'u_ravi', 'u_neha', 'u_arjun'], 120);
  c('RTZENE-5Q1V-8Y4Z', 'Elite Pass',  'Scrim winners ko',     3, ['u_ava', 'u_ravi', 'u_neha'], 6);

  console.log('[rtzene] seeded fresh database');
}

/* ------------------------------------------------------------------ utils */

function hashPass(p) {
  const salt = crypto.randomBytes(12).toString('hex');
  return salt + '$' + crypto.scryptSync(p, salt, 32).toString('hex');
}
function checkPass(p, stored) {
  if (!stored || !stored.includes('$')) return false;
  const [salt, want] = stored.split('$');
  const got = crypto.scryptSync(p, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(want, 'hex'));
}

/* ------------------------------------------------------------------- reads */

const initials = (name) =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, handle: u.handle, about: u.about, hue: u.hue,
           initials: initials(u.name), is_admin: !!u.is_admin, last_seen: u.last_seen };
}

function getUser(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function userByHandle(h) {
  return db.prepare('SELECT * FROM users WHERE handle = ?').get(String(h || '').replace(/^@/, ''));
}

function listChats(viewerId) {
  const rows = db.prepare(`
    SELECT c.* FROM chats c
    JOIN chat_members m ON m.chat_id = c.id
    WHERE m.user_id = ?
    ORDER BY c.pinned DESC, c.created_at ASC
  `).all(viewerId);

  const lastStmt = db.prepare(
    'SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1'
  );
  const othersStmt = db.prepare(`
    SELECT u.* FROM users u
    JOIN chat_members m ON m.user_id = u.id
    WHERE m.chat_id = ? AND u.id != ?
    ORDER BY u.name
  `);
  const unreadStmt = db.prepare(
    'SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND sender_id != ? AND read_at IS NULL'
  );

  return rows.map((c) => {
    const others = othersStmt.all(c.id, viewerId);
    const last = lastStmt.get(c.id) || null;
    const title = c.kind === 'group' ? c.name : (others[0] ? others[0].name : 'Note to self');
    return {
      id: c.id,
      kind: c.kind,
      title,
      hue: c.kind === 'group' ? c.hue : (others[0] ? others[0].hue : c.hue),
      initials: c.kind === 'group'
        ? c.name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase()
        : (others[0] ? initials(others[0].name) : 'ME'),
      members: others.map(publicUser),
      member_count: others.length + 1,
      pinned: !!c.pinned,
      muted: !!c.muted,
      unread: unreadStmt.get(c.id, viewerId).n,
      preview: last
        ? (last.kind === 'code' ? 'Redeem code bheja' : last.body)
        : 'Abhi koi message nahi',
      preview_kind: last ? last.kind : null,
      preview_from: last && last.sender_id === viewerId ? 'You' : (last ? (others.find(o=>o.id===last.sender_id)||{}).name || '' : ''),
      last_at: last ? last.created_at : c.created_at,
    };
  }).sort((a, b) => b.last_at - a.last_at);
}

function listMessages(chatId, viewerId) {
  db.prepare(
    'UPDATE messages SET read_at = ? WHERE chat_id = ? AND sender_id != ? AND read_at IS NULL'
  ).run(now(), chatId, viewerId);

  const rows = db.prepare(
    'SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC LIMIT 400'
  ).all(chatId);
  const senderStmt = db.prepare('SELECT * FROM users WHERE id = ?');

  return rows.map((r) => {
    const s = senderStmt.get(r.sender_id);
    return {
      id: r.id, chat_id: r.chat_id, body: r.body, kind: r.kind, code: r.code,
      created_at: r.created_at, mine: r.sender_id === viewerId,
      sender: s ? { id: s.id, name: s.name, hue: s.hue, initials: initials(s.name) } : null,
      state: r.read_at ? 'read' : (r.delivered ? 'delivered' : 'sent'),
    };
  });
}

function activeStatuses() {
  return db.prepare(`
    SELECT s.*, u.name, u.hue FROM statuses s
    JOIN users u ON u.id = s.user_id
    WHERE s.expires_at > ?
    ORDER BY s.created_at ASC
  `).all(now()).map((r) => ({
    id: r.id, name: r.name, hue: r.hue, initials: initials(r.name),
    body: r.body, at: r.created_at, expires_at: r.expires_at,
  }));
}

/* The redemptions table is the single source of truth for how many times a
   code has been taken. codes.uses is a convenience counter only — trusting it
   for state is what let seeded codes read "used up, 0 of 3". */
const claimCount = db.prepare('SELECT COUNT(*) AS n FROM redemptions WHERE code_id = ?');
function claimed(row) {
  return claimCount.get(row.id).n;
}
function codeState(row, taken = null) {
  if (!row.active) return 'paused';
  if (row.expires_at && row.expires_at < now()) return 'expired';
  const used = taken === null ? claimed(row) : taken;
  if (used >= row.max_uses) return 'used up';
  return 'live';
}
function publicCode(row) {
  const taken = claimed(row);
  return {
    id: row.id, code: row.code, reward: row.reward, note: row.note,
    max_uses: row.max_uses, uses: taken, expires_at: row.expires_at,
    active: !!row.active, state: codeState(row, taken), created_at: row.created_at,
    redeemed: taken, live_left: Math.max(0, row.max_uses - taken),
  };
}

function listCodes(includeHidden) {
  const rows = db.prepare('SELECT * FROM codes ORDER BY created_at DESC').all();
  const withCounts = rows.map((r) => publicCode(r));
  return includeHidden ? withCounts : withCounts.filter((c) => c.state !== 'used up');
}

function codeLedger() {
  return db.prepare(`
    SELECT r.at, u.name AS who, u.hue, c.code, c.reward, ch.name AS group_name
    FROM redemptions r
    JOIN users u ON u.id = r.user_id
    JOIN codes c ON c.id = r.code_id
    LEFT JOIN chats ch ON ch.id = r.chat_id
    ORDER BY r.at DESC LIMIT 40
  `).all().map((r) => ({
    at: r.at, who: r.who, hue: r.hue, code: r.code, reward: r.reward, where: r.group_name || 'Direct',
  }));
}

function myRedemptions(userId) {
  return db.prepare(`
    SELECT r.at, c.code, c.reward FROM redemptions r
    JOIN codes c ON c.id = r.code_id
    WHERE r.user_id = ? ORDER BY r.at DESC LIMIT 50
  `).all(userId).map((r) => ({ at: r.at, code: r.code, reward: r.reward }));
}

function stats() {
  const one = (sql) => db.prepare(sql).get().n;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return {
    codes_total: one('SELECT COUNT(*) AS n FROM codes'),
    codes_live: db.prepare('SELECT * FROM codes').all().filter((c) => codeState(c) === 'live').length,
    redeemed: one('SELECT COUNT(*) AS n FROM redemptions'),
    redeemed_today: db.prepare('SELECT COUNT(*) AS n FROM redemptions WHERE at >= ?').get(today.getTime()).n,
    messages: one('SELECT COUNT(*) AS n FROM messages'),
    people: one('SELECT COUNT(*) AS n FROM users'),
  };
}

/* ------------------------------------------------------------------ writes */

function createMessage({ chatId, senderId, body, kind = 'text', code = null }) {
  const id = uid('m');
  db.prepare(
    'INSERT INTO messages (id,chat_id,sender_id,body,kind,code,created_at,delivered,read_at) VALUES (?,?,?,?,?,?,?,1,?)'
  ).run(id, chatId, senderId, body, kind, code, now(), null);
  touchChat(chatId);
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
}

function touchChat(chatId) {
  db.prepare('UPDATE chats SET created_at = created_at WHERE id = ?').run(chatId);
}

function getOrCreateDm(viewerId, otherId) {
  const found = db.prepare(`
    SELECT c.id FROM chats c
    JOIN chat_members a ON a.chat_id = c.id AND a.user_id = ?
    JOIN chat_members b ON b.chat_id = c.id AND b.user_id = ?
    WHERE c.kind = 'dm' LIMIT 1
  `).get(viewerId, otherId);
  if (found) return found.id;

  const id = uid('c');
  db.prepare('INSERT INTO chats (id,kind,name,hue,created_at) VALUES (?,?,?,?,?)')
    .run(id, 'dm', null, 0, now());
  const add = db.prepare('INSERT INTO chat_members (chat_id,user_id,joined_at) VALUES (?,?,?)');
  add.run(id, viewerId, now());
  add.run(id, otherId, now());
  return id;
}

function createGroup({ name, memberIds }) {
  const id = uid('c');
  const hue = Math.floor(Math.random() * 360);
  db.prepare('INSERT INTO chats (id,kind,name,hue,created_at) VALUES (?,?,?,?,?)')
    .run(id, 'group', name, hue, now());
  const add = db.prepare('INSERT OR IGNORE INTO chat_members (chat_id,user_id,joined_at) VALUES (?,?,?)');
  for (const m of new Set(memberIds)) add.run(id, m, now());
  return id;
}

function createStatus(userId, body) {
  const id = uid('s');
  db.prepare('INSERT INTO statuses (id,user_id,body,created_at,expires_at) VALUES (?,?,?,?,?)')
    .run(id, userId, body, now(), now() + 24 * 3600_000);
  return id;
}

function createCode({ code, reward, note, maxUses, hours, userId }) {
  const clean = String(code).trim().toUpperCase().replace(/\s+/g, '-');
  const id = uid('k');
  const expires = hours ? now() + Number(hours) * 3600_000 : null;
  db.prepare(
    'INSERT INTO codes (id,code,reward,note,max_uses,uses,expires_at,active,created_at) VALUES (?,?,?,?,?,0,?,1,?)'
  ).run(id, clean, reward, note || '', Math.max(1, Number(maxUses) || 1), expires, now());
  return db.prepare('SELECT * FROM codes WHERE id = ?').get(id);
}

function redeem({ codeText, userId, chatId = null }) {
  const clean = String(codeText).trim().toUpperCase().replace(/\s+/g, '-');
  const row = db.prepare('SELECT * FROM codes WHERE code = ?').get(clean);
  if (!row) return { ok: false, reason: 'not_found', message: 'Is naam ka koi code nahi hai. Spelling check karo.' };
  if (!row.active) return { ok: false, reason: 'paused', message: 'Ye code abhi band hai. Owner se poocho.' };
  if (row.expires_at && row.expires_at < now()) return { ok: false, reason: 'expired', message: 'Ye code expire ho gaya. Naya code dekho.' };

  const before = db.prepare(
    'SELECT COUNT(*) AS n FROM redemptions WHERE code_id = ? AND user_id = ?'
  ).get(row.id, userId).n;
  if (before > 0) return { ok: false, reason: 'already', message: 'Tum ye code pehle le chuke ho.' };

  if (claimed(row) >= row.max_uses) return { ok: false, reason: 'used_up', message: 'Ye code ki limit poori ho gayi.' };

  db.prepare('INSERT INTO redemptions (id,code_id,user_id,chat_id,at) VALUES (?,?,?,?,?)')
    .run(uid('r'), row.id, userId, chatId, now());
  db.prepare('UPDATE codes SET uses = uses + 1 WHERE id = ?').run(row.id);
  return { ok: true, reward: row.reward, code: row.code, message: 'Code chal gaya — ' + row.reward };
}

function sendCodeToChat({ codeId, chatId, senderId }) {
  const row = db.prepare('SELECT * FROM codes WHERE id = ?').get(codeId);
  if (!row) return null;
  return createMessage({
    chatId, senderId,
    body: row.code + ' — ' + row.reward,
    kind: 'code', code: row.code,
  });
}

function setCodeActive(id, active) {
  db.prepare('UPDATE codes SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
  return db.prepare('SELECT * FROM codes WHERE id = ?').get(id);
}

function deleteCode(id) {
  db.prepare('DELETE FROM codes WHERE id = ?').run(id);
}

function updateUser(id, fields) {
  const u = getUser(id);
  if (!u) return null;
  db.prepare('UPDATE users SET name = ?, about = ?, last_seen = ? WHERE id = ?')
    .run(fields.name ?? u.name, fields.about ?? u.about, now(), id);
  return getUser(id);
}

function touchSeen(id) {
  db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now(), id);
}

function createSession(userId) {
  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO sessions (token,user_id,created_at) VALUES (?,?,?)')
    .run(token, userId, now());
  return token;
}

function sessionUser(token) {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!s) return null;
  return getUser(s.user_id);
}

function dropSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

module.exports = {
  db, seed, now, uid, hashPass, checkPass,
  publicUser, getUser, userByHandle, initials,
  listChats, listMessages, activeStatuses,
  listCodes, codeLedger, myRedemptions, stats, publicCode, codeState,
  createMessage, createGroup, createStatus, createCode, redeem, getOrCreateDm,
  sendCodeToChat, setCodeActive, deleteCode, updateUser, touchSeen,
  createSession, sessionUser, dropSession,
};
