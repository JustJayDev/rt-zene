'use strict';
/* RT ZENE — client. No framework, no build step. */

const S = {
  me: null, chats: [], statuses: [], codes: [], mine: [],
  stats: {}, ledger: [], people: [], adminCodes: [],
  chatId: null, messages: [], view: 'chats', q: '', reduceMotion: false,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '"', "'": '&#39;' }[c]));

function clock(ms) {
  const d = new Date(ms), now = new Date();
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { day: '2-digit', month: 'short' });
}

function dayLabel(ms) {
  const d = new Date(ms), now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' });
}

function until(ms) {
  if (!ms) return 'no expiry';
  const left = ms - Date.now();
  if (left <= 0) return 'expired';
  const h = Math.floor(left / 3600000);
  if (h >= 24) return Math.floor(h / 24) + 'd left';
  if (h >= 1) return h + 'h left';
  return Math.max(1, Math.floor(left / 60000)) + 'm left';
}

function seen(ms) {
  const diff = Date.now() - (ms || Date.now());
  if (diff < 60000) return 'online';
  if (diff < 3600000) return 'last seen ' + Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return 'last seen ' + Math.floor(diff / 3600000) + 'h ago';
  return 'last seen ' + Math.floor(diff / 86400000) + 'd ago';
}

const icon = (n, cls = 'ic') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${n}"></use></svg>`;

function av(name, hue, size = '') {
  const ini = String(name || '?').trim().split(/\s+/).slice(0, 2)
    .map((w) => w[0]).join('').toUpperCase();
  return `<span class="av ${size}" style="--h:${hue}">${esc(ini)}</span>`;
}

function toast(text, bad = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' toast--bad' : '');
  el.textContent = text;
  $('#toast-root').append(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 160ms'; }, 2200);
  setTimeout(() => el.remove(), 2500);
}

async function api(path, opts = {}) {
  const res = await fetch('/api/' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, data };
}

function sheet(title, items) {
  const root = $('#sheet-root');
  root.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet__grab" aria-hidden="true"></div>
      <h2 class="sheet__title">${esc(title)}</h2>
      ${items.map((it, i) => `
        <button class="sheet__opt" type="button" data-opt="${i}">
          ${it.icon ? icon(it.icon) : ''}
          <span><span>${esc(it.label)}</span>${it.sub ? `<span class="sheet__sub">${esc(it.sub)}</span>` : ''}</span>
        </button>`).join('')}
      <button class="sheet__cancel" type="button" data-opt="-1">Band karo</button>
    </div>`;
  root.hidden = false;
  return new Promise((resolve) => {
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-opt]');
      if (!b && e.target !== root) return;
      const i = b ? Number(b.dataset.opt) : -1;
      root.hidden = true; root.innerHTML = '';
      resolve(i >= 0 ? items[i] : null);
    }, { once: true });
  });
}
/* ------------------------------------------------------------------ render */

function renderChats() {
  const q = S.q.trim().toLowerCase();
  const shown = S.chats.filter((c) => {
    if (!q) return true;
    if (c.title.toLowerCase().includes(q)) return true;
    return c.members.some((m) => m.name.toLowerCase().includes(q) || m.handle.includes(q));
  });

  $('#chats-blank').hidden = shown.length > 0;

  $('#chat-rows').innerHTML = shown.map((c) => `
    <li>
      <button class="row" type="button" data-chat="${c.id}">
        ${av(c.title, c.hue)}
        <span class="row__mid">
          <span class="row__title">${esc(c.title)}${c.kind === 'group' ? ` <span class="pill pill--ghost">${c.member_count}</span>` : ''}</span>
          <span class="row__line">
            ${c.preview_kind === 'code' ? icon('ticket') : ''}
            ${c.preview_from ? `<b>${esc(c.preview_from)}:</b>` : ''}
            <span class="row__snip">${esc(c.preview)}</span>
          </span>
        </span>
        <span class="row__end">
          <span class="row__at">${esc(clock(c.last_at))}</span>
          ${c.unread ? `<span class="pill">${c.unread}</span>` : ''}
          ${c.pinned ? `<span class="row__at">pinned</span>` : ''}
        </span>
      </button>
    </li>`).join('');
}

function renderThread() {
  const el = $('#thread');
  const chat = S.chats.find((c) => c.id === S.chatId);
  let lastDay = '';
  const out = [];

  for (const m of S.messages) {
    const day = dayLabel(m.created_at);
    if (day !== lastDay) { out.push(`<span class="daybreak">${esc(day)}</span>`); lastDay = day; }

    if (m.kind === 'system') {
      out.push(`<div class="bub bub--sys"><p class="bub__body">${esc(m.body)}</p></div>`);
      continue;
    }

    const showWho = chat?.kind === 'group' && !m.mine;
    const who = showWho && m.sender
      ? `<div class="bub__who" style="color:hsl(${m.sender.hue} 52% 62%)">${esc(m.sender.name)}</div>` : '';

    if (m.kind === 'code') {
      out.push(`
        <div class="bub bub--code${m.mine ? ' bub--mine' : ''}">
          ${who}
          <p class="bub__body">${esc(m.code || m.body)}</p>
          <button class="bub__claim" type="button" data-claim="${esc(m.code || '')}">Code claim karo</button>
          <div class="bub__foot"><span>${esc(clock(m.created_at))}</span></div>
        </div>`);
      continue;
    }

    out.push(`
      <div class="bub${m.mine ? ' bub--mine' : ''}">
        ${who}
        <p class="bub__body">${esc(m.body)}</p>
        <div class="bub__foot">
          <span>${esc(clock(m.created_at))}</span>
          ${m.mine ? `<svg class="tick${m.state === 'read' ? ' tick--read' : ''}" aria-label="${m.state}"><use href="#i-check"></use></svg>` : ''}
        </div>
      </div>`);
  }

  el.innerHTML = out.join('') || '<p class="blank">Abhi koi message nahi. Neeche likh ke shuru karo.</p>';
  el.scrollTop = el.scrollHeight;
}

function renderStatus() {
  $('#status-rows').innerHTML = S.statuses.map((s) => `
    <li>
      <div class="row">
        <span class="ring">${av(s.name, s.hue)}</span>
        <span class="row__mid">
          <span class="row__title">${esc(s.name)}</span>
          <span class="status__body">${esc(s.body)}</span>
        </span>
        <span class="row__end">
          <span class="status__at">${esc(until(s.expires_at))}</span>
          <span class="row__at">${esc(clock(s.at))}</span>
        </span>
      </div>
    </li>`).join('') || '<li><p class="blank">Koi status live nahi hai. Neeche apna lagao — 24 ghante dikhega.</p></li>';
}

function renderCodes() {
  const taken = new Set(S.mine.map((m) => m.code));
  const live = S.codes.filter((c) => c.state === 'live');

  $('#code-list').innerHTML = live.map((c) => `
    <li class="entry"${taken.has(c.code) ? ' style="opacity:.55"' : ''}>
      <span class="entry__code">${esc(c.code)}</span>
      <span class="entry__reward">${esc(c.reward)}</span>
      ${c.note ? `<span class="entry__note">${esc(c.note)}</span>` : ''}
      <span class="entry__end">
        <span class="state state--live">live</span>
        <span class="meter">${c.live_left} of ${c.max_uses} bache</span>
        <span class="meter">${esc(until(c.expires_at))}</span>
      </span>
    </li>`).join('');

  $('#codes-blank').hidden = live.length > 0;

  $('#my-redeems').innerHTML = S.mine.map((m) => `
    <li class="entry">
      <span class="entry__code">${esc(m.code)}</span>
      <span class="entry__reward">${esc(m.reward)}</span>
      <span class="entry__end"><span class="meter">${esc(clock(m.at))}</span></span>
    </li>`).join('');

  $('#mine-blank').hidden = S.mine.length > 0;
}

function renderYou() {
  $('#me-form').name.value = S.me.name;
  $('#me-form').about.value = S.me.about;
  $('#tgl-motion').checked = S.reduceMotion;

  $('#people-rows').innerHTML = S.people.filter((p) => p.id !== S.me.id).map((p) => `
    <li>
      <button class="row" type="button" data-dm="${esc(p.handle)}">
        ${av(p.name, p.hue)}
        <span class="row__mid">
          <span class="row__title">${esc(p.name)}</span>
          <span class="row__line"><span class="row__snip">@${esc(p.handle)} · ${esc(seen(p.last_seen))}</span></span>
        </span>
        <span class="row__end">${icon('chat')}</span>
      </button>
    </li>`).join('');

  $('#admin-gate').innerHTML = S.me.is_admin
    ? '<p class="hint hint--good">Admin haath me hai. Codes banao, pause karo, chat me bhejo.</p>'
    : `<span class="field__label">Admin passphrase</span>
       <input type="password" id="pass-input" placeholder="Passphrase daalo" autocomplete="off">
       <button class="btn btn--go" type="button" id="pass-go">Admin kholo</button>`;
}

function renderAdmin() {
  const s = S.stats;
  const cells = [
    [s.codes_live, 'live codes'], [s.codes_total, 'total codes'],
    [s.redeemed, 'redeemed'], [s.redeemed_today, 'redeemed today'],
    [s.messages, 'messages'], [s.people, 'log'],
  ];
  $('#admin-stats').innerHTML = cells.map(([n, k]) =>
    `<div class="stat"><div class="stat__n">${n ?? 0}</div><div class="stat__k">${esc(k)}</div></div>`).join('');

  const st = (c) => 'state--' + c.state.replace(' ', '');
  $('#admin-codes').innerHTML = S.adminCodes.map((c) => `
    <li class="entry entry--admin">
      <span class="entry__code">${esc(c.code)}</span>
      <span class="entry__reward">${esc(c.reward)}</span>
      ${c.note ? `<span class="entry__note">${esc(c.note)}</span>` : ''}
      <span class="entry__acts">
        <button class="icon-btn" type="button" data-act="toggle" data-id="${c.id}" data-on="${c.active ? 1 : 0}" title="${c.active ? 'Pause' : 'Resume'}">${icon(c.active ? 'pause' : 'play')}</button>
        <button class="icon-btn" type="button" data-act="send" data-id="${c.id}" title="Chat me bhejo">${icon('send')}</button>
        <button class="icon-btn" type="button" data-act="copy" data-code="${esc(c.code)}" title="Copy">${icon('copy')}</button>
        <button class="icon-btn icon-btn--danger" type="button" data-act="del" data-id="${c.id}" title="Delete">${icon('trash')}</button>
      </span>
      <span class="entry__end">
        <span class="state ${st(c)}">${esc(c.state)}</span>
        <span class="meter">${c.redeemed} of ${c.max_uses} liye</span>
        <span class="meter">${esc(until(c.expires_at))}</span>
      </span>
    </li>`).join('') || '<li><p class="blank">Abhi koi code nahi. Upar form se pehla code banao.</p></li>';

  $('#admin-ledger').innerHTML = S.ledger.map((l) => `
    <li class="entry">
      <span class="entry__code">${esc(l.code)}</span>
      <span class="entry__reward">${esc(l.who)} ne liya — ${esc(l.reward)}</span>
      <span class="entry__note">${esc(l.where)}</span>
      <span class="entry__end"><span class="meter">${esc(clock(l.at))}</span></span>
    </li>`).join('') || '<li><p class="blank">Koi redeem hua nahi abhi.</p></li>';
}
/* -------------------------------------------------------------- navigation */

const VIEWS = { chats: 'v-chats', thread: 'v-thread', status: 'v-status', codes: 'v-codes', you: 'v-you', admin: 'v-admin' };
const TITLES = { status: 'Status', codes: 'Codes', you: 'You', admin: 'Admin panel' };
const MARK = '<span class="mark" aria-hidden="true"><svg viewBox="0 0 32 32"><g fill="none" stroke="currentColor" stroke-width="1.6"><rect x="7" y="7" width="18" height="18"/><rect x="7" y="7" width="18" height="18" transform="rotate(45 16 16)"/><circle cx="16" cy="16" r="4.2" stroke-width="2"/></g></svg></span>';

const isDesktop = () => window.matchMedia('(min-width: 900px)').matches;

function updateStage(view) {
  const desktop = isDesktop();
  for (const [k, id] of Object.entries(VIEWS)) {
    const el = document.getElementById(id);
    if (!el) continue;
    const show = k === view || (desktop && k === 'chats');
    el.hidden = !show;
    el.style.display = show ? '' : 'none';
  }
  const hint = $('#pane-hint');
  if (hint) hint.hidden = !(desktop && view === 'chats');
}

function go(view) {
  S.view = view;
  updateStage(view);

  const bar = $('#bar-id'), acts = $('#bar-act');
  bar.innerHTML = ''; acts.innerHTML = '';
  $('#btn-back').hidden = view !== 'thread';

  if (view === 'thread') {
    const c = S.chats.find((x) => x.id === S.chatId);
    const sub = c?.kind === 'group'
      ? c.member_count + ' members'
      : seen(c?.members?.[0]?.last_seen);
    bar.innerHTML = `${av(c?.title || '?', c?.hue ?? 42, 'av--sm')}
      <span><span class="bar__name">${esc(c?.title || '')}</span><span class="bar__sub">${esc(sub)}</span></span>`;
    acts.innerHTML = `
      <button type="button" id="act-pin" aria-label="Pin chat">${icon('shield')}</button>
      <button type="button" id="act-menu" aria-label="Chat options">${icon('more')}</button>`;
    $('#act-pin').onclick = async () => {
      await api(`chats/${c.id}/pin`, { method: 'POST', body: { pinned: !c.pinned } });
      toast(c.pinned ? 'Unpin ho gaya' : 'Pin ho gaya');
      await refresh(); go('chats');
    };
    $('#act-menu').onclick = () => chatMenu(c);
  } else {
    bar.innerHTML = `${MARK}<span class="wordmark">${esc(TITLES[view] || 'RT ZENE')}</span>`;
    if (view === 'you' && S.me?.is_admin) {
      acts.innerHTML = `<button type="button" id="act-admin" aria-label="Admin panel">${icon('shield')}</button>`;
      $('#act-admin').onclick = () => go('admin');
    }
    if (view === 'admin') {
      acts.innerHTML = `<button type="button" id="act-you" aria-label="Back to you">${icon('back')}</button>`;
      $('#act-you').onclick = () => go('you');
    }
  }

  for (const b of $$('#tabs button')) {
    if (view === 'admin') b.removeAttribute('aria-current');
    else if (b.dataset.go === view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }

  if (view === 'chats') renderChats();
  if (view === 'thread') renderThread();
  if (view === 'status') renderStatus();
  if (view === 'codes') renderCodes();
  if (view === 'you') renderYou();
  if (view === 'admin') renderAdmin();
}

/* ------------------------------------------------------------------ actions */

async function openChat(id) { S.chatId = id; await loadThread(); go('thread'); }

async function loadThread() {
  if (!S.chatId) return;
  const { data } = await api(`chats/${S.chatId}/messages`);
  S.messages = data.messages || [];
  const { data: b } = await api('chats');
  S.chats = b.chats || [];
  if (S.view === 'thread') renderThread();
}

async function send() {
  const box = $('#compose');
  const text = box.value.trim();
  if (!text || !S.chatId) return;
  box.value = ''; box.style.height = 'auto';
  const r = await api(`chats/${S.chatId}/messages`, { method: 'POST', body: { body: text } });
  if (!r.ok) { toast(r.data.message || 'Message nahi gaya', true); box.value = text; return; }
  await loadThread();
}

async function refresh() {
  const { ok, data } = await api('bootstrap');
  if (!ok) return;
  Object.assign(S, {
    me: data.me, chats: data.chats, statuses: data.statuses, codes: data.codes,
    mine: data.my_redemptions, stats: data.stats, ledger: data.ledger, people: data.people,
  });

  if (S.me.is_admin) {
    const { data: a } = await api('admin/codes');
    S.adminCodes = a.codes || [];
    S.ledger = a.ledger || [];
    S.stats = a.stats || S.stats;
  }

  if (S.view === 'chats') renderChats();
  if (S.view === 'codes') renderCodes();
  if (S.view === 'status') renderStatus();
  if (S.view === 'admin') renderAdmin();
  if (S.view === 'you') renderYou();
  renderCounts();
}

function renderCounts() {
  const tab = $('#tabs button[data-go="chats"]');
  const old = $('.count', tab);
  if (old) old.remove();
  const unread = S.chats.reduce((n, c) => n + c.unread, 0);
  if (unread > 0) {
    const span = document.createElement('span');
    span.className = 'count';
    span.textContent = unread;
    tab.append(span);
  }
}

async function chatMenu(c) {
  const pick = await sheet('Chat options', [
    { label: c.pinned ? 'Unpin karo' : 'Pin karo', icon: 'shield' },
    { label: 'Codes tab kholo', icon: 'ticket' },
  ]);
  if (!pick) return;
  if (pick.label.includes('Pin')) {
    await api(`chats/${c.id}/pin`, { method: 'POST', body: { pinned: !c.pinned } });
    await refresh(); go('chats');
  } else go('codes');
}

async function newChatFlow() {
  const others = S.people.filter((p) => p.id !== S.me.id);
  const pick = await sheet('Naya kya?', [
    { label: 'Kisi ko message karo', sub: others.map((p) => p.name).join(', '), icon: 'user' },
    { label: 'Group banao', sub: 'Ek saath kai logon se baat', icon: 'chat' },
  ]);
  if (!pick) return;

  const who = await sheet('Kisko?', others.map((p) => ({ label: p.name, sub: '@' + p.handle, icon: 'user' })));
  if (!who) return;
  const target = others.find((p) => p.name === who.label);
  if (!target) return;

  if (pick.label.includes('message')) {
    const r = await api('chats/dm', { method: 'POST', body: { handle: target.handle } });
    await refresh();
    if (r.ok) openChat(r.data.chat_id);
    return;
  }

  const name = prompt('Group ka naam?');
  if (!name) return;
  const r = await api('chats/group', { method: 'POST', body: { name, handles: [target.handle] } });
  await refresh();
  if (r.ok) { toast('Group ban gaya: ' + name); openChat(r.data.chat_id); }
}

async function sendCodeFlow() {
  const live = S.codes.filter((c) => c.state === 'live');
  if (!live.length) { toast('Koi live code nahi. Pehle Codes tab me banao.', true); return; }
  const pick = await sheet('Code bhejo', live.map((c) => ({
    label: c.code, sub: `${c.reward} · ${c.live_left} bache · ${until(c.expires_at)}`, icon: 'ticket',
  })));
  if (!pick || !S.chatId) return;
  const row = live.find((c) => c.code === pick.label);
  const r = await api(`chats/${S.chatId}/messages`, {
    method: 'POST', body: { body: `${row.code} — ${row.reward}` },
  });
  if (r.ok) { await loadThread(); toast('Code bhej diya'); }
}

async function adminSendCode(id, codeLabel) {
  const pool = S.chats;
  if (!pool.length) { toast('Koi chat nahi hai', true); return; }
  const where = await sheet('Kahan bhejo?', pool.map((c) => ({
    label: c.title, sub: c.kind === 'group' ? c.member_count + ' members' : 'direct chat', icon: 'chat',
  })));
  if (!where) return;
  const chat = pool.find((c) => c.title === where.label);
  const r = await api(`admin/codes/${id}/send`, { method: 'POST', body: { chat_id: chat.id } });
  toast(r.ok ? `${codeLabel} → ${chat.title}` : 'Bhej nahi paya', !r.ok);
}
/* ------------------------------------------------------------------ wiring */

function wire() {
  $('#btn-back').onclick = () => { S.chatId = null; go('chats'); refresh(); };
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-go]');
    if (b) go(b.dataset.go);
  });

  $('#q').addEventListener('input', (e) => { S.q = e.target.value; renderChats(); });
  $('#chat-rows').addEventListener('click', (e) => {
    const b = e.target.closest('[data-chat]');
    if (b) openChat(b.dataset.chat);
  });

  $('#btn-send').onclick = send;
  $('#compose').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $('#compose').addEventListener('input', (e) => {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 128) + 'px';
  });

  $('#fab-new').onclick = newChatFlow;
  $('#btn-attach').onclick = sendCodeFlow;

  $('#thread').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-claim]');
    if (!b) return;
    b.disabled = true;
    const r = await api('redeem', { method: 'POST', body: { code: b.dataset.claim, chat_id: S.chatId } });
    toast(r.data.message, !r.ok);
    await refresh(); await loadThread();
  });

  $('#status-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await api('status', { method: 'POST', body: { body: new FormData(e.target).get('body') } });
    if (r.ok) { e.target.reset(); toast('Status lag gaya'); await refresh(); }
    else toast(r.data.message || 'Status nahi laga', true);
  });

  $('#redeem-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const box = $('#redeem-msg');
    const r = await api('redeem', { method: 'POST', body: { code: new FormData(e.target).get('code') } });
    box.hidden = false;
    box.className = 'hint ' + (r.ok ? 'hint--good' : 'hint--bad');
    box.textContent = r.data.message;
    if (r.ok) { e.target.reset(); await refresh(); }
  });

  $('#me-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const r = await api('me', { method: 'POST', body: { name: fd.get('name'), about: fd.get('about') } });
    if (r.ok) { toast('Save ho gaya'); await refresh(); }
  });

  $('#tgl-motion').addEventListener('change', (e) => {
    S.reduceMotion = e.target.checked;
    document.body.classList.toggle('reduce-motion', S.reduceMotion);
    localStorage.setItem('rtzene.reduce', S.reduceMotion ? '1' : '0');
  });

  $('#v-you').addEventListener('click', async (e) => {
    if (e.target.closest('#pass-go')) {
      const r = await api('passphrase', { method: 'POST', body: { pass: $('#pass-input').value } });
      if (r.ok) { toast('Admin khul gaya'); await refresh(); go('admin'); }
      else toast(r.data.message || 'Galat passphrase', true);
      return;
    }
    const b = e.target.closest('[data-dm]');
    if (!b) return;
    const r = await api('chats/dm', { method: 'POST', body: { handle: b.dataset.dm } });
    await refresh();
    if (r.ok) openChat(r.data.chat_id);
  });

  $('#code-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target, fd = new FormData(form), box = $('#code-msg');
    const r = await api('admin/codes', {
      method: 'POST',
      body: {
        code: fd.get('code'), reward: fd.get('reward'), note: fd.get('note'),
        maxUses: Number(fd.get('maxUses')), hours: Number(fd.get('hours')),
      },
    });
    box.hidden = false;
    box.className = 'hint ' + (r.ok ? 'hint--good' : 'hint--bad');
    box.textContent = r.ok
      ? `${r.data.code.code} ban gaya — ${r.data.code.reward}`
      : (r.data.message || 'Code nahi bana');
    if (r.ok) { form.reset(); form.maxUses.value = 1; form.hours.value = 24; await refresh(); }
  });

  $('#admin-codes').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const { act, id, code, on } = b.dataset;

    if (act === 'toggle') {
      await api(`admin/codes/${id}/active`, { method: 'POST', body: { active: on !== '1' } });
      toast(on === '1' ? 'Code pause ho gaya' : 'Code chalu ho gaya');
      await refresh();
      return;
    }

    if (act === 'copy') {
      try { await navigator.clipboard.writeText(code); toast('Copy ho gaya: ' + code); }
      catch { toast('Copy nahi hua — haath se likho', true); }
      return;
    }

    if (act === 'send') { await adminSendCode(id, code || 'Code'); return; }

    if (act === 'del') {
      const yes = await sheet('Pakka delete?', [
        { label: 'Haan, delete karo', sub: 'Wapas nahi aayega', icon: 'trash' },
      ]);
      if (!yes) return;
      await api(`admin/codes/${id}`, { method: 'DELETE' });
      toast('Delete ho gaya');
      await refresh();
    }
  });
}

/* -------------------------------------------------------------------- live */

function live() {
  try {
    const es = new EventSource('/api/events');
    es.onmessage = async () => {
      await refresh();
      if (S.view === 'thread') await loadThread();
    };
  } catch { /* SSE unavailable — app still works, just not live */ }
}

/* -------------------------------------------------------------------- boot */

(async function boot() {
  if (localStorage.getItem('rtzene.reduce') === '1') {
    S.reduceMotion = true;
    document.body.classList.add('reduce-motion');
  }
  wire();
  await refresh();
  go('chats');
  window.addEventListener('resize', () => updateStage(S.view));
  live();
  document.body.dataset.ready = '1';
})();
