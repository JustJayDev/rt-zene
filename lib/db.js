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

CREATE TABLE IF NOT EXISTS communities (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  tagline     TEXT NOT NULL DEFAULT '',
  hue         INTEGER NOT NULL DEFAULT 0,
  owner_id    TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS community_members (
  community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'member',   -- 'owner' | 'admin' | 'member'
  joined_at    INTEGER NOT NULL,
  PRIMARY KEY (community_id, user_id)
);

CREATE TABLE IF NOT EXISTS chats (
  id          TEXT PRIMARY KEY,
  community_id TEXT REFERENCES communities(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,              -- 'dm' | 'group'
  name        TEXT,                       -- groups only
  hue         INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  pinned      INTEGER NOT NULL DEFAULT 0,
  muted       INTEGER NOT NULL DEFAULT 0,
  post_policy TEXT NOT NULL DEFAULT 'all', -- 'all' | 'admin'  (admin = Announcements)
  position    INTEGER NOT NULL DEFAULT 0
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
  community_id TEXT REFERENCES communities(id) ON DELETE CASCADE, -- which community's codes
  code        TEXT NOT NULL UNIQUE,
  reward      TEXT NOT NULL,              -- label people read ("1000 UC")
  value       INTEGER NOT NULL DEFAULT 0, -- rupees this credits to the wallet
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

/* Wallet ledger. Like redemptions, the ledger is the truth — balance is always
   SUM(credits) - SUM(debits), never a stored counter that can drift. */
CREATE TABLE IF NOT EXISTS wallet_entries (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,              -- 'credit' | 'debit'
  amount      INTEGER NOT NULL,           -- rupees, always positive
  reason      TEXT NOT NULL,              -- 'code' | 'payout'
  ref_id      TEXT,                       -- code id or payout id
  at          INTEGER NOT NULL
);

/* A request to turn wallet balance into a Google Play code the admin delivers. */
CREATE TABLE IF NOT EXISTS payouts (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount      INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending', -- pending|approved|delivered|rejected
  note        TEXT NOT NULL DEFAULT '',        -- user's ask ("Jio number pe bhejo")
  code_text   TEXT,                            -- the Google Play code admin delivers
  admin_note  TEXT NOT NULL DEFAULT '',        -- why rejected / extra info
  requested_at INTEGER NOT NULL,
  decided_at  INTEGER,
  decided_by  TEXT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_msg_chat  ON messages(chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_red_code  ON redemptions(code_id);
CREATE INDEX IF NOT EXISTS idx_red_user  ON redemptions(user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_user ON wallet_entries(user_id, at);
CREATE INDEX IF NOT EXISTS idx_payout_user ON payouts(user_id, requested_at);
`);
/* Lightweight migration for databases created before the wallet existed. */
function addColumn(table, col, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}
addColumn('codes', 'value', 'INTEGER NOT NULL DEFAULT 0');
addColumn('codes', 'community_id', 'TEXT');
addColumn('chats', 'community_id', 'TEXT');
addColumn('chats', 'post_policy', "TEXT NOT NULL DEFAULT 'all'");
addColumn('chats', 'position', 'INTEGER NOT NULL DEFAULT 0');

/* Payout rules the admin controls. min_payout = balance needed before asking;
   step = allowed Google Play denomination size (also the multiple amounts snap to). */
const SETTING_DEFAULTS = {
  min_payout: '300',
  payout_step: '100',
  payout_note: 'Google Play code 24 ghante me milega.',
};
function setting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (row) return row.value;
  return SETTING_DEFAULTS[key] ?? '';
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
  return setting(key);
}
function payoutRules() {
  const min = Math.max(1, Number(setting('min_payout')) || 300);
  const step = Math.max(1, Number(setting('payout_step')) || 100);
  return { min, step, note: setting('payout_note') };
}

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

  const insertCommunity = db.prepare(
    'INSERT INTO communities (id,name,tagline,hue,owner_id,created_at) VALUES (?,?,?,?,?,?)'
  );
  const insertCMember = db.prepare(
    'INSERT INTO community_members (community_id,user_id,role,joined_at) VALUES (?,?,?,?)'
  );
  /* Two communities so the inbox actually reads like an inbox, not a stubbed list.
     TQG is the real one for Jay; the second exists so switching communities is testable. */
  insertCommunity.run('com_tqg', 'TQG Squad', 'Scrims, drops aur squad talk', 42, 'u_owner', now() - 40 * 86_400_000);
  insertCommunity.run('com_kaizen', 'Kaizen Circle', 'Aim, mindset aur daily grind', 268, 'u_ravi', now() - 18 * 86_400_000);

  for (const u of ['u_owner', 'u_ava', 'u_ravi', 'u_neha', 'u_arjun'])
    insertCMember.run('com_tqg', u, u === 'u_owner' ? 'owner' : 'member', now() - 40 * 86_400_000);
  for (const u of ['u_ravi', 'u_owner', 'u_ava'])
    insertCMember.run('com_kaizen', u, u === 'u_ravi' ? 'owner' : 'member', now() - 18 * 86_400_000);

const insertChat = db.prepare(
    'INSERT INTO chats (id,community_id,kind,name,hue,created_at,pinned,post_policy,position) VALUES (?,?,?,?,?,?,?,?,?)'
  );
  const insertMember = db.prepare(
    'INSERT INTO chat_members (chat_id,user_id,joined_at) VALUES (?,?,?)'
  );
  /* Inside a community: Announcements first (admin-only posting), then groups.
     DMs keep community_id NULL so they stay outside any community, like the real app. */
  const chats = [
    ['g_tqg_ann',  'com_tqg',    'group', 'Announcements',  42, 1, 'admin', 0],
    ['g_tqg_scrim','com_tqg',    'group', 'Scrims',         42, 0, 'all',   1],
    ['g_tqg_clips','com_tqg',    'group', 'Clips',         198, 0, 'all',   2],
    ['g_tqg_gen',  'com_tqg',    'group', 'General',        42, 0, 'all',   3],
    ['g_kz_ann',   'com_kaizen', 'group', 'Announcements', 268, 1, 'admin', 0],
    ['g_kz_aim',   'com_kaizen', 'group', 'Aim Lab',        268, 0, 'all',   1],
    ['c_ava',      null,         'dm',    null,             158, 0, 'all',   0],
    ['c_neha',     null,         'dm',    null,              18, 0, 'all',   0],
  ];
  for (const [id, com, kind, name, hue, pinned, policy, pos] of chats) {
    insertChat.run(id, com, kind, name, hue, now(), pinned, policy, pos);
  }
  /* Memberships: everyone in both communities sits in every group of that community. */
  const tqgPeople = ['u_owner', 'u_ava', 'u_ravi', 'u_neha', 'u_arjun'];
  const kzPeople  = ['u_ravi', 'u_owner', 'u_ava'];
  for (const g of ['g_tqg_ann', 'g_tqg_scrim', 'g_tqg_clips', 'g_tqg_gen'])
    for (const u of tqgPeople) insertMember.run(g, u, now());
  for (const g of ['g_kz_ann', 'g_kz_aim'])
    for (const u of kzPeople) insertMember.run(g, u, now());
  for (const [chat, mate] of [['c_ava', 'u_ava'], ['c_neha', 'u_neha']]) {
    insertMember.run(chat, 'u_owner', now());
    insertMember.run(chat, mate, now());
  }

  const insertMsg = db.prepare(
    'INSERT INTO messages (id,chat_id,sender_id,body,kind,code,created_at,delivered,read_at) VALUES (?,?,?,?,?,?,?,?,?)'
  );
  const m = (chat, from, body, minsAgo, kind = 'text', code = null, read = 1) =>
    insertMsg.run(uid('m'), chat, from, body, kind, code, now() - minsAgo * 60_000, 1, read ? now() - minsAgo * 60_000 + 8000 : null);

  m('g_tqg_ann', 'u_owner', 'Sab log 7:15 pe online ho jao. Scrim 7:30 pe.', 21);
  m('g_tqg_ann', 'u_owner', 'Aaj ka code 8 baje. Sirf Announcements me milega — yahin dekhte rehna.', 16);
  m('g_tqg_scrim', 'u_arjun', 'Kal ka scrim 7:30 pe shift ho gaya.', 24);
  m('g_tqg_scrim', 'u_neha',  'Theek hai, main time pe aa jaungi.', 19);
  m('g_tqg_scrim', 'u_owner', 'Room ID main 7:20 pe bhej dunga.', 14);
  m('g_tqg_clips', 'u_ava',   'Aaj ka 1v4 clutch, dekho.', 52);
  m('g_tqg_gen',   'u_ravi',  'Koi custom room hai aaj?', 40);
  m('g_tqg_gen',   'u_owner', 'Haan 9 baje. Squad ko bhi bol dena.', 38);
  m('g_kz_ann',    'u_ravi',  'Aim routine kal se 6 baje. Late mat aana.', 300);
  m('g_kz_aim',    'u_ava',   'Naya sensitivity try kiya, fark pad gaya.', 180);
  m('c_ava', 'u_ava',   'Bhai aaj custom room hai kya?', 46);
  m('c_ava', 'u_owner', 'Haan 9 baje. Link bhej dunga.', 44);
  m('c_ava', 'u_ava',   'Perfect. Squad ko bhi bol deti hu.', 43);
  m('c_ava', 'u_owner', 'Ye le, aaj ka drop.', 13);
  insertMsg.run(uid('m'), 'c_ava', 'u_owner', 'RTZENE-9X4K-2P7Q', 'code', 'RTZENE-9X4K-2P7Q', now() - 12 * 60_000, 1, now() - 11 * 60_000);
  m('c_neha', 'u_neha',  'Ye naya app kya hai?', 520);
  m('c_neha', 'u_owner', 'RT ZENE. Community plus redeem codes.', 515, 'text', null, 0);

  const insertStatus = db.prepare(
    'INSERT INTO statuses (id,user_id,body,created_at,expires_at) VALUES (?,?,?,?,?)'
  );
  const st = (u, body, minsAgo) =>
    insertStatus.run(uid('s'), u, body, now() - minsAgo * 60_000, now() + (24 * 60 - minsAgo) * 60_000);
  st('u_ava',  'Rank push chal raha hai, wish me luck.', 40);
  st('u_ravi', 'Naya sensitivity try kiya, fark pad gaya.', 180);
  st('u_neha', 'Aaj ka last match. GG all.', 300);

  const insertCode = db.prepare(
    'INSERT INTO codes (id,community_id,code,reward,value,note,max_uses,uses,expires_at,active,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  );
  const insertClaim = db.prepare(
    'INSERT INTO redemptions (id,code_id,user_id,chat_id,at) VALUES (?,?,?,?,?)'
  );
  const insertCredit = db.prepare(
    'INSERT INTO wallet_entries (id,user_id,kind,amount,reason,ref_id,at) VALUES (?,?,?,?,?,?,?)'
  );
  /* Seeded codes carry REAL ledger rows, not just a uses counter — otherwise the
     list says "used up" while the meter says "0 of 3". They also write real wallet
     credits, so the demo balances match the claims instead of being made up. */
  const c = (code, reward, value, note, max, claimers, hrs, community) => {
    const id = uid('k');
    insertCode.run(id, community || null, code, reward, value, note, max, claimers.length, now() + hrs * 3600_000, 1, now() - 3600_000);
    claimers.forEach((u, i) => {
      const at = now() - (90 - i * 7) * 60_000;
      insertClaim.run(uid('r'), id, u, null, at);
      insertCredit.run(uid('w'), u, 'credit', value, 'code', id, at);
    });
  };
  c('RTZENE-9X4K-2P7Q', '1000 UC',     500, 'Squad room giveaway',  1, ['u_ava'], 20, 'com_tqg');
  c('RTZENE-7H2M-5R9T', '500 UC',      250, 'Status reply ke liye', 5, ['u_ravi', 'u_neha'], 48, 'com_tqg');
  c('RTZENE-3W8N-1J6B', 'Diamond 310', 150, 'Weekly drop',         20, ['u_ava', 'u_ravi', 'u_neha', 'u_arjun'], 120, 'com_tqg');
  c('RTZENE-5Q1V-8Y4Z', 'Elite Pass',  100, 'Scrim winners ko',     3, ['u_ava', 'u_ravi', 'u_neha'], 6, 'com_kaizen');

  /* One payout already in flight, so the admin queue isn't an empty promise on
     first open. It writes its own debit, exactly like a real request. */
  const pid = uid('p');
  db.prepare('INSERT INTO payouts (id,user_id,amount,status,note,requested_at) VALUES (?,?,?,?,?,?)')
    .run(pid, 'u_ravi', 300, 'pending', 'Jio number pe bhejo', now() - 22 * 60_000);
  db.prepare('INSERT INTO wallet_entries (id,user_id,kind,amount,reason,ref_id,at) VALUES (?,?,?,?,?,?,?)')
    .run(uid('w'), 'u_ravi', 'debit', 300, 'payout', pid, now() - 22 * 60_000);

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

/* ------------------------------------------------------------ communities */
function communityRole(communityId, userId) {
  const row = db.prepare(
    'SELECT role FROM community_members WHERE community_id = ? AND user_id = ?'
  ).get(communityId, userId);
  return row ? row.role : null;
}
function listCommunities(viewerId) {
  const rows = db.prepare(`
    SELECT c.* FROM communities c
    JOIN community_members m ON m.community_id = c.id
    WHERE m.user_id = ?
    ORDER BY c.created_at ASC
  `).all(viewerId);
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM community_members WHERE community_id = ?');
  /* Announcements is a channel, not a group — same split as getCommunity(),
     otherwise the inbox count and the hub list disagree. */
  const groupsStmt = db.prepare(
    "SELECT COUNT(*) AS n FROM chats WHERE community_id = ? AND kind = 'group' AND post_policy != 'admin'"
  );
  const annStmt = db.prepare(`
    SELECT m.*, u.name AS sender_name FROM messages m
    JOIN chats c ON c.id = m.chat_id
    JOIN users u ON u.id = m.sender_id
    WHERE c.community_id = ? AND c.post_policy = 'admin'
    ORDER BY m.created_at DESC LIMIT 1
  `);
  return rows.map((c) => {
    const ann = annStmt.get(c.id) || null;
    return {
      id: c.id, name: c.name, tagline: c.tagline, hue: c.hue,
      role: communityRole(c.id, viewerId),
      member_count: countStmt.get(c.id).n,
      group_count: groupsStmt.get(c.id).n,
      last_announcement: ann ? { body: ann.body, from: ann.sender_name, at: ann.created_at } : null,
    };
  });
}
function getCommunity(communityId, viewerId) {
  const c = db.prepare('SELECT * FROM communities WHERE id = ?').get(communityId);
  if (!c) return null;
  const role = communityRole(communityId, viewerId);
  if (!role) return null;   // not a member: invisible, not just unreadable
  const groups = db.prepare(`
    SELECT g.* FROM chats g
    WHERE g.community_id = ? AND g.kind = 'group'
    ORDER BY g.position ASC, g.created_at ASC
  `).all(communityId);
  const lastStmt = db.prepare(
    'SELECT m.*, u.name AS sender_name FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.chat_id = ? ORDER BY m.created_at DESC LIMIT 1'
  );
  const unreadStmt = db.prepare(
    'SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND sender_id != ? AND read_at IS NULL'
  );
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM chat_members WHERE chat_id = ?');
  return {
    id: c.id, name: c.name, tagline: c.tagline, hue: c.hue, role,
    member_count: db.prepare('SELECT COUNT(*) AS n FROM community_members WHERE community_id = ?').get(communityId).n,
    announcements: groups.filter((g) => g.post_policy === 'admin').map((g) => {
      const last = lastStmt.get(g.id) || null;
      return {
        id: g.id, name: g.name, hue: g.hue, post_policy: g.post_policy,
        member_count: countStmt.get(g.id).n,
        unread: unreadStmt.get(g.id, viewerId).n,
        last_at: last ? last.created_at : g.created_at,
      };
    }),
    groups: groups.filter((g) => g.post_policy !== 'admin').map((g) => {
      const last = lastStmt.get(g.id) || null;
      return {
        id: g.id, name: g.name, hue: g.hue, post_policy: g.post_policy,
        member_count: countStmt.get(g.id).n,
        unread: unreadStmt.get(g.id, viewerId).n,
        preview: last ? last.body : 'Abhi koi message nahi',
        preview_from: last ? last.sender_name : '',
        last_at: last ? last.created_at : g.created_at,
      };
    }),
    members: db.prepare(`
      SELECT u.*, m.role FROM community_members m
      JOIN users u ON u.id = m.user_id
      WHERE m.community_id = ?
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.name
    `).all(communityId).map((u) => ({ ...publicUser(u), role: u.role })),
  };
}
function canPost(chatId, userId) {
  const g = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
  if (!g) return { ok: false, reason: 'missing' };
  if (g.post_policy !== 'admin') return { ok: true };
  if (!g.community_id) return { ok: true };
  const role = communityRole(g.community_id, userId);
  if (role === 'owner' || role === 'admin') return { ok: true };
  return { ok: false, reason: 'announce_only' };
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
      community_id: c.community_id || null,
      community_name: c.community_id
        ? (db.prepare('SELECT name FROM communities WHERE id = ?').get(c.community_id) || {}).name || null
        : null,
      post_policy: c.post_policy,
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
    id: row.id, code: row.code, reward: row.reward, value: row.value, note: row.note,
    community_id: row.community_id || null,
    max_uses: row.max_uses, uses: taken, expires_at: row.expires_at,
    active: !!row.active, state: codeState(row, taken), created_at: row.created_at,
    redeemed: taken, live_left: Math.max(0, row.max_uses - taken),
  };
}

function listCodes(includeHidden, communityId) {
  const rows = communityId
    ? db.prepare('SELECT * FROM codes WHERE community_id = ? ORDER BY created_at DESC').all(communityId)
    : db.prepare('SELECT * FROM codes ORDER BY created_at DESC').all();
  const withCounts = rows.map((r) => publicCode(r));
  return includeHidden ? withCounts : withCounts.filter((c) => c.state !== 'used up');
}
/* What a member may see in their Wallet: codes from the communities they are in.
   A code posted in one squad must not show up for another squad's member. */
function listCodesForViewer(viewerId) {
  const rows = db.prepare(`
    SELECT c.* FROM codes c
    JOIN community_members m ON m.community_id = c.community_id
    WHERE m.user_id = ?
    ORDER BY c.created_at DESC
  `).all(viewerId);
  /* Legacy codes with no community stay visible to everyone, so old data isn't lost. */
  const orphan = db.prepare('SELECT * FROM codes WHERE community_id IS NULL ORDER BY created_at DESC').all();
  return [...new Map([...rows, ...orphan].map((r) => [r.id, publicCode(r)])).values()];
}

function codeLedger() {
  return db.prepare(`
    SELECT r.at, u.name AS who, u.hue, c.code, c.reward,
           ch.name AS group_name, com.name AS community_name
    FROM redemptions r
    JOIN users u ON u.id = r.user_id
    JOIN codes c ON c.id = r.code_id
    LEFT JOIN chats ch ON ch.id = r.chat_id
    LEFT JOIN communities com ON com.id = c.community_id
    ORDER BY r.at DESC LIMIT 40
  `).all().map((r) => ({
    at: r.at, who: r.who, hue: r.hue, code: r.code, reward: r.reward,
    where: r.group_name || r.community_name || 'Wallet',
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
    ...payoutStats(),
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

function createCode({ code, reward, value, note, maxUses, hours, userId, communityId }) {
  const clean = String(code).trim().toUpperCase().replace(/\s+/g, '-');
  const id = uid('k');
  const expires = hours ? now() + Number(hours) * 3600_000 : null;
  db.prepare(
    'INSERT INTO codes (id,community_id,code,reward,value,note,max_uses,uses,expires_at,active,created_at) VALUES (?,?,?,?,?,?,?,0,?,1,?)'
  ).run(id, communityId || null, clean, reward, Math.max(0, Math.round(Number(value) || 0)), note || '', Math.max(1, Number(maxUses) || 1), expires, now());
  return db.prepare('SELECT * FROM codes WHERE id = ?').get(id);
}

function redeem({ codeText, userId, chatId = null }) {
  const clean = String(codeText).trim().toUpperCase().replace(/\s+/g, '-');
  const row = db.prepare('SELECT * FROM codes WHERE code = ?').get(clean);
  if (!row) return { ok: false, reason: 'not_found', message: 'Is naam ka koi code nahi hai. Spelling check karo.' };
  if (!row.active) return { ok: false, reason: 'paused', message: 'Ye code abhi band hai. Owner se poocho.' };
  if (row.expires_at && row.expires_at < now()) return { ok: false, reason: 'expired', message: 'Ye code expire ho gaya. Naya code dekho.' };

  /* Codes belong to a community. Only that community's members can claim them —
     otherwise a code handed out in one squad leaks to everyone. */
  if (row.community_id && !communityRole(row.community_id, userId)) {
    return { ok: false, reason: 'not_member', message: 'Ye code kisi aur community ka hai. Tum us community me nahi ho.' };
  }

  const before = db.prepare(
    'SELECT COUNT(*) AS n FROM redemptions WHERE code_id = ? AND user_id = ?'
  ).get(row.id, userId).n;
  if (before > 0) return { ok: false, reason: 'already', message: 'Tum ye code pehle le chuke ho.' };

  if (claimed(row) >= row.max_uses) return { ok: false, reason: 'used_up', message: 'Ye code ki limit poori ho gayi.' };

  db.prepare('INSERT INTO redemptions (id,code_id,user_id,chat_id,at) VALUES (?,?,?,?,?)')
    .run(uid('r'), row.id, userId, chatId, now());
  db.prepare('UPDATE codes SET uses = uses + 1 WHERE id = ?').run(row.id);
  /* The claim pays into the wallet in the same breath, so "code liya" and
     "paisa aaya" can never disagree. */
  if (row.value > 0) {
    db.prepare('INSERT INTO wallet_entries (id,user_id,kind,amount,reason,ref_id,at) VALUES (?,?,?,?,?,?,?)')
      .run(uid('w'), userId, 'credit', row.value, 'code', row.id, now());
  }
  return {
    ok: true, reward: row.reward, value: row.value, code: row.code,
    balance: walletBalance(userId),
    message: 'Code chal gaya — ' + row.reward + (row.value > 0 ? ` (+₹${row.value} wallet me)` : ''),
  };
}

/* ------------------------------------------------------------ wallet + payouts
   Balance is derived from the ledger every time. No stored counter to drift. */
function walletBalance(userId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN kind = 'credit' THEN amount ELSE -amount END), 0) AS n
    FROM wallet_entries WHERE user_id = ?
  `).get(userId);
  return Number(row.n) || 0;
}
function walletHistory(userId, limit = 40) {
  return db.prepare(`
    SELECT w.at, w.kind, w.amount, w.reason, c.code, c.reward
    FROM wallet_entries w
    LEFT JOIN codes c ON c.id = w.ref_id AND w.reason = 'code'
    WHERE w.user_id = ?
    ORDER BY w.at DESC LIMIT ?
  `).all(userId, limit).map((r) => ({
    at: r.at, kind: r.kind, amount: r.amount, reason: r.reason,
    label: r.reason === 'code'
      ? `${r.code || 'code'} — ${r.reward || ''}`.trim()
      : (r.reason === 'refund' ? 'Payout reject — paise wapas' : 'Google Play payout request'),
  }));
}
function payoutSummary(userId) {
  const rules = payoutRules();
  const balance = walletBalance(userId);
  /* The debit is written when the request is made, so `balance` already excludes
     money held by pending requests. Subtracting `pending` again here would count
     the same hold twice and show a smaller "available" than the user really has. */
  const pending = Number(db.prepare(`
    SELECT COALESCE(SUM(amount),0) AS n FROM payouts
    WHERE user_id = ? AND status IN ('pending','approved')
  `).get(userId).n) || 0;
  const available = Math.max(0, balance);
  /* Amounts must be a whole number of Play denominations and above the floor. */
  const options = [];
  for (let a = rules.min; a <= available; a += rules.step) options.push(a);
  const canRequest = available >= rules.min;
  return {
    balance, pending, available,
    can_request: canRequest, options,
    rules: { ...rules, unit: `₹${rules.step}` },
    shortfall: canRequest ? 0 : rules.min - available,
  };
}
function listPayouts(userId) {
  return db.prepare(`
    SELECT p.*, u.name AS user_name, u.hue AS user_hue
    FROM payouts p JOIN users u ON u.id = p.user_id
    WHERE p.user_id = ? ORDER BY p.requested_at DESC LIMIT 30
  `).all(userId).map(publicPayout);
}
function listAllPayouts() {
  return db.prepare(`
    SELECT p.*, u.name AS user_name, u.hue AS user_hue
    FROM payouts p JOIN users u ON u.id = p.user_id
    ORDER BY CASE p.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, p.requested_at DESC
    LIMIT 60
  `).all().map(publicPayout);
}
function publicPayout(r) {
  return {
    id: r.id, user_id: r.user_id, user: r.user_name, hue: r.user_hue,
    amount: r.amount, status: r.status, note: r.note,
    code_text: r.code_text, admin_note: r.admin_note,
    requested_at: r.requested_at, decided_at: r.decided_at,
  };
}
function requestPayout({ userId, amount, note }) {
  const rules = payoutRules();
  const want = Math.round(Number(amount) || 0);
  const sum = payoutSummary(userId);
  if (!want || want <= 0) return { ok: false, reason: 'no_amount', message: 'Kitna chahiye, wo amount daalo.' };
  if (want % rules.step !== 0) {
    return {
      ok: false, reason: 'bad_step',
      message: `Google Play code ₹${rules.step} ke multiple me milta hai. ₹${rules.step * Math.round(want / rules.step)} ya uske aas paas chuno.`,
    };
  }
  if (want < rules.min) {
    return { ok: false, reason: 'below_min', message: `Minimum ₹${rules.min} chahiye. Tumhare paas ₹${sum.balance} hai.` };
  }
  if (want > sum.available) {
    return {
      ok: false, reason: 'not_enough',
      message: sum.pending > 0
        ? `₹${sum.pending} ka request already pending hai. Abhi ₹${sum.available} available hai.`
        : `Tumhare paas sirf ₹${sum.balance} hai.`,
    };
  }
  const id = uid('p');
  db.prepare(
    'INSERT INTO payouts (id,user_id,amount,status,note,requested_at) VALUES (?,?,?,?,?,?)'
  ).run(id, userId, want, 'pending', String(note || '').slice(0, 140), now());
  /* Hold the money immediately: a debit row means the balance can't be spent twice. */
  db.prepare('INSERT INTO wallet_entries (id,user_id,kind,amount,reason,ref_id,at) VALUES (?,?,?,?,?,?,?)')
    .run(uid('w'), userId, 'debit', want, 'payout', id, now());
  const row = db.prepare('SELECT * FROM payouts WHERE id = ?').get(id);
  return { ok: true, payout: publicPayout(row), balance: walletBalance(userId), message: `₹${want} ka request chala gaya. Admin ke paas hai.` };
}
function decidePayout({ payoutId, action, codeText, adminNote, adminId }) {
  const p = db.prepare('SELECT * FROM payouts WHERE id = ?').get(payoutId);
  if (!p) return { ok: false, reason: 'not_found', message: 'Aisa koi request nahi hai.' };
  if (action === 'deliver') {
    if (p.status === 'delivered') return { ok: false, reason: 'done', message: 'Ye already deliver ho chuka hai.' };
    if (p.status === 'rejected') return { ok: false, reason: 'rejected', message: 'Ye request reject ho chuki hai. Pehle user naya banaaye.' };
    const code = String(codeText || '').trim();
    if (!code) return { ok: false, reason: 'no_code', message: 'Google Play code daalo jo user ko milega.' };
    db.prepare(
      "UPDATE payouts SET status = 'delivered', code_text = ?, admin_note = ?, decided_at = ?, decided_by = ? WHERE id = ?"
    ).run(code, String(adminNote || '').slice(0, 140), now(), adminId, payoutId);
    return { ok: true, message: `₹${p.amount} ka code deliver ho gaya.`, balance: walletBalance(p.user_id) };
  }
  if (action === 'reject') {
    if (p.status === 'rejected') return { ok: false, reason: 'done', message: 'Ye already reject ho chuka hai.' };
    if (p.status === 'delivered') return { ok: false, reason: 'delivered', message: 'Deliver ho chuka hai — reject nahi kar sakte.' };
    db.prepare(
      "UPDATE payouts SET status = 'rejected', admin_note = ?, decided_at = ?, decided_by = ? WHERE id = ?"
    ).run(String(adminNote || 'Reject kiya admin ne').slice(0, 140), now(), adminId, payoutId);
    /* Refund the held amount so the user gets their balance back. */
    db.prepare('INSERT INTO wallet_entries (id,user_id,kind,amount,reason,ref_id,at) VALUES (?,?,?,?,?,?,?)')
      .run(uid('w'), p.user_id, 'credit', p.amount, 'refund', p.id, now());
    return { ok: true, message: `₹${p.amount} wapas wallet me daal diya.`, balance: walletBalance(p.user_id) };
  }
  return { ok: false, reason: 'bad_action', message: 'Kya karna hai wo samajh nahi aaya.' };
}
function payoutStats() {
  const one = (sql) => Number(db.prepare(sql).get().n) || 0;
  return {
    pending: one("SELECT COUNT(*) AS n FROM payouts WHERE status = 'pending'"),
    delivered: one("SELECT COUNT(*) AS n FROM payouts WHERE status = 'delivered'"),
    credited: one("SELECT COALESCE(SUM(amount),0) AS n FROM wallet_entries WHERE kind = 'credit' AND reason = 'code'"),
    paid_out: one("SELECT COALESCE(SUM(amount),0) AS n FROM payouts WHERE status = 'delivered'"),
  };
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
  listCommunities, getCommunity, communityRole, canPost,
  listChats, listMessages, activeStatuses,
  listCodes, listCodesForViewer, codeLedger, myRedemptions, stats, publicCode, codeState,
  createMessage, createGroup, createStatus, createCode, redeem, getOrCreateDm,
  sendCodeToChat, setCodeActive, deleteCode, updateUser, touchSeen,
  setting, setSetting, payoutRules,
  walletBalance, walletHistory, payoutSummary, listPayouts, listAllPayouts,
  requestPayout, decidePayout, payoutStats, publicPayout,
  createSession, sessionUser, dropSession,
};
