'use strict';
/* RT ZENE — client. No framework, no build step. */

const S = {
  me: null, communities: [], chats: [], statuses: [], codes: [], mine: [],
  stats: {}, ledger: [], people: [], adminCodes: [], community: null, communityId: null,
  wallet: null, walletHistory: [], myPayouts: [], allPayouts: [], payoutRules: null,
  communityCodes: [], chatId: null, messages: [], view: 'inbox', q: '', reduceMotion: false,
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
  /* Round to the nearest day/hour instead of flooring, so "48h" doesn't read as
     "1d left" the moment a minute has passed. */
  if (h >= 24) return Math.round(h / 24) + 'd left';
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
/* Sheet with a text field — for things like pasting a Google Play code. */
function askText(title, { label = '', placeholder = '', multiline = false, confirm = 'Save' } = {}) {
  const root = $('#sheet-root');
  root.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet__grab" aria-hidden="true"></div>
      <h2 class="sheet__title">${esc(title)}</h2>
      <form class="sheet__form" id="ask-form">
        ${label ? `<span class="field__label">${esc(label)}</span>` : ''}
        ${multiline
          ? `<textarea name="value" rows="3" placeholder="${esc(placeholder)}"></textarea>`
          : `<input name="value" placeholder="${esc(placeholder)}" class="mono" autocomplete="off" spellcheck="false">`}
        <div class="sheet__acts">
          <button class="btn" type="button" data-cancel>Band karo</button>
          <button class="btn btn--go" type="submit">${esc(confirm)}</button>
        </div>
      </form>
    </div>`;
  root.hidden = false;
  const input = $('#ask-form [name=value]');
  setTimeout(() => input.focus(), 40);
  return new Promise((resolve) => {
    const done = (v) => { root.hidden = true; root.innerHTML = ''; resolve(v); };
    root.addEventListener('click', (e) => {
      if (e.target.closest('[data-cancel]') || e.target === root) done(null);
    });
    root.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = input.value.trim();
      done(v || null);
    });
  });
}
/* ------------------------------------------------------------------ render */
function renderInbox() {
  const q = S.q.trim().toLowerCase();

  const coms = S.communities.filter((c) => !q || c.name.toLowerCase().includes(q));
  const dmOnly = S.chats.filter((c) => !c.community_id);
  const dms = dmOnly.filter((c) => !q || c.title.toLowerCase().includes(q));

  $('#com-blank').hidden = coms.length > 0;
  $('#chats-blank').hidden = dms.length > 0;

  $('#community-rows').innerHTML = coms.map((c) => {
    const ann = c.last_announcement;
    return `
    <li>
      <button class="row row--com" type="button" data-community="${c.id}">
        <span class="com-tile" style="--h:${c.hue}">${av(c.name, c.hue)}</span>
        <span class="row__mid">
          <span class="row__title">${esc(c.name)}</span>
          <span class="row__line">
            <span class="row__snip">${ann ? `${esc(ann.from)}: ${esc(ann.body)}` : esc(c.tagline || 'Abhi koi announcement nahi')}</span>
          </span>
        </span>
        <span class="row__end">
          <span class="row__at">${ann ? esc(clock(ann.at)) : ''}</span>
          <span class="row__at">${c.group_count} groups</span>
        </span>
      </button>
    </li>`;
  }).join('');

  $('#chat-rows').innerHTML = dms.map((c) => `
    <li>
      <button class="row" type="button" data-chat="${c.id}">
        ${av(c.title, c.hue)}
        <span class="row__mid">
          <span class="row__title">${esc(c.title)}</span>
          <span class="row__line">
            ${c.preview_kind === 'code' ? icon('ticket') : ''}
            ${c.preview_from ? `<b>${esc(c.preview_from)}:</b>` : ''}
            <span class="row__snip">${esc(c.preview)}</span>
          </span>
        </span>
        <span class="row__end">
          <span class="row__at">${esc(clock(c.last_at))}</span>
          ${c.unread ? `<span class="pill">${c.unread}</span>` : ''}
        </span>
      </button>
    </li>`).join('');
}

function renderCommunity() {
  const c = S.community;
  if (!c) return;

  $('#com-head').innerHTML = `
    <div class="com-banner" style="--h:${c.hue}">
      ${av(c.name, c.hue, 'av--lg')}
      <div>
        <h1 class="com-name">${esc(c.name)}</h1>
        <p class="com-tag">${esc(c.tagline || '')}</p>
        <p class="com-meta">${c.member_count} members · ${c.groups.length} groups · ${esc(c.role)}</p>
      </div>
    </div>`;

  const annRow = (g) => `
    <li>
      <button class="row row--ann" type="button" data-chat="${g.id}">
        <span class="ann-ic">${icon('megaphone')}</span>
        <span class="row__mid">
          <span class="row__title">${esc(g.name)} <span class="pill pill--lock">${icon('lock')} admin only</span></span>
          <span class="row__line"><span class="row__snip">Sab members ko dikhta hai. Sirf admin likh sakta hai.</span></span>
        </span>
        <span class="row__end">
          <span class="row__at">${esc(clock(g.last_at))}</span>
          ${g.unread ? `<span class="pill">${g.unread}</span>` : ''}
        </span>
      </button>
    </li>`;

  $('#com-ann').innerHTML = c.announcements.map(annRow).join('')
    || '<li><p class="blank">Koi announcement group nahi.</p></li>';

  $('#com-groups').innerHTML = c.groups.map((g) => `
    <li>
      <button class="row" type="button" data-chat="${g.id}">
        ${av(g.name, g.hue)}
        <span class="row__mid">
          <span class="row__title">${esc(g.name)} <span class="pill pill--ghost">${g.member_count}</span></span>
          <span class="row__line">
            ${g.preview_from ? `<b>${esc(g.preview_from)}:</b>` : ''}
            <span class="row__snip">${esc(g.preview)}</span>
          </span>
        </span>
        <span class="row__end">
          <span class="row__at">${esc(clock(g.last_at))}</span>
          ${g.unread ? `<span class="pill">${g.unread}</span>` : ''}
        </span>
      </button>
    </li>`).join('') || '<li><p class="blank">Is community me abhi koi group nahi.</p></li>';

  $('#com-members').innerHTML = c.members.map((m) => `
    <li class="person">
      ${av(m.name, m.hue, 'av--sm')}
      <span class="person__mid">
        <span class="person__name">${esc(m.name)}</span>
        <span class="person__sub">@${esc(m.handle)}</span>
      </span>
      <span class="pill pill--ghost">${esc(m.role)}</span>
    </li>`).join('');

  /* Codes for this community. Owners can add; everyone can claim from Wallet. */
  const mineSet = new Set(S.mine.map((m) => m.code));
  const canManage = c.role === 'owner' || c.role === 'admin';
  $('#com-code-form-wrap').hidden = !canManage;
  $('#com-codes').innerHTML = (S.communityCodes || []).map((k) => `
    <li class="entry">
      <span class="entry__code">${esc(k.code)}</span>
      <span class="entry__reward">${esc(k.reward)}${k.value ? ` · ₹${k.value}` : ''}</span>
      ${k.note ? `<span class="entry__note">${esc(k.note)}</span>` : ''}
      ${canManage ? `<span class="entry__acts">
        <button class="icon-btn" type="button" data-com-code="toggle" data-id="${k.id}" data-on="${k.active ? 1 : 0}" title="${k.active ? 'Pause' : 'Resume'}">${icon(k.active ? 'pause' : 'play')}</button>
        <button class="icon-btn" type="button" data-com-code="copy" data-code="${esc(k.code)}" title="Copy">${icon('copy')}</button>
        <button class="icon-btn icon-btn--danger" type="button" data-com-code="del" data-id="${k.id}" title="Delete">${icon('trash')}</button>
      </span>` : ''}
      <span class="entry__end">
        <span class="state ${k.state === 'live' ? 'state--live' : 'state--usedup'}">${esc(k.state)}</span>
        <span class="meter">${k.redeemed} of ${k.max_uses} liye</span>
        <span class="meter">${mineSet.has(k.code) ? 'tumne liya' : esc(until(k.expires_at))}</span>
      </span>
    </li>`).join('') || '';
  $('#com-codes-blank').hidden = (S.communityCodes || []).length > 0;
}

async function openCommunity(id) {
  S.communityId = id;
  const { ok, data } = await api(`communities/${id}`);
  if (!ok) { toast('Community khuli nahi', true); return; }
  S.community = data.community;
  const { data: k } = await api(`communities/${id}/codes`);
  S.communityCodes = k.codes || [];
  go('community');
}
function openAnnounce() {
  const c = S.community;
  if (!c) return;
  const ann = c.announcements[0];
  if (!ann) { toast('Pehle koi announcement group banao', true); return; }
  openChat(ann.id);
}

function renderThread() {
  const el = $('#thread');
  const chat = S.chats.find((c) => c.id === S.chatId);
  const isAnn = chat?.post_policy === 'admin';
  const canPost = !isAnn || isAnnAdmin(chat);

  let lastDay = '';
  const out = [];

  if (isAnn) {
    out.push(`<div class="ann-note">
      ${icon('megaphone')}
      <span><b>Announcement channel.</b> Sirf admin likh sakta hai. Baaki sab padh sakte hain — reply nahi.</span>
    </div>`);
  }

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

  /* Announcements: members get no composer at all — just a locked line. The
     server refuses anyway; this is so nobody types a message into a dead box. */
  const tray = $('#tray');
  const locked = isAnn && !canPost;
  tray.hidden = locked;
  if (locked) {
    let note = $('#ann-locked');
    if (!note) {
      note = document.createElement('p');
      note.id = 'ann-locked';
      note.className = 'tray--locked';
      tray.parentElement.appendChild(note);
    }
    note.innerHTML = `${icon('lock')} Sirf admin announce kar sakta hai.`;
    note.hidden = false;
  } else {
    const note = $('#ann-locked');
    if (note) note.hidden = true;
  }
}
/* Announcements are writable by the community owner/admin. S.me.is_admin is the
   code-panel flag and is not enough on its own. */
function isAnnAdmin(chat) {
  const com = S.community;
  if (com && chat?.community_id === com.id) return com.role === 'owner' || com.role === 'admin';
  return !!S.me?.is_admin;
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
  const w = S.wallet || { balance: 0, pending: 0, available: 0, can_request: false, options: [], rules: { min: 300, step: 100, note: '' }, shortfall: 0 };

  $('#wallet-card').innerHTML = `
    <div class="wallet__main">
      <span class="wallet__label">Wallet</span>
      <span class="wallet__amt">₹${w.balance}</span>
      <span class="wallet__sub">${w.pending > 0 ? `₹${w.pending} ka request pending` : 'Koi request pending nahi'}</span>
    </div>
    <div class="wallet__side">
      <span class="wallet__mini"><b>₹${w.available}</b><span>Use kar sakte ho</span></span>
      <span class="wallet__mini"><b>${w.can_request ? 'Ready' : '₹' + w.shortfall}</b><span>${w.can_request ? 'Payout maang sakte ho' : 'Aur chahiye'}</span></span>
    </div>`;

  const rule = w.rules || {};
  $('#payout-rule').innerHTML = w.can_request
    ? `Minimum ₹${rule.min} · Google Play code ₹${rule.step} ke multiple me. ${esc(rule.note || '')}`
    : `Payout ke liye kam se kam ₹${rule.min} chahiye. Abhi ₹${w.available} available — ₹${w.shortfall} aur chahiye.`;

  const opts = w.options || [];
  $('#amount-chips').innerHTML = opts.length
    ? opts.map((a) => `<button class="chip" type="button" data-amount="${a}">₹${a}</button>`).join('')
    : '';
  $('#amount-chips').hidden = !opts.length;
  $('#payout-go').disabled = !w.can_request;
  $('#payout-go').textContent = w.can_request ? 'Request bhejo' : `₹${w.shortfall} aur chahiye`;

  const live = S.codes.filter((c) => c.state === 'live');
  $('#code-list').innerHTML = live.map((c) => `
    <li class="entry"${taken.has(c.code) ? ' style="opacity:.55"' : ''}>
      <span class="entry__code">${esc(c.code)}</span>
      <span class="entry__reward">${esc(c.reward)}${c.value ? ` · ₹${c.value}` : ''}</span>
      ${c.note ? `<span class="entry__note">${esc(c.note)}</span>` : ''}
      <span class="entry__end">
        <span class="state state--live">live</span>
        <span class="meter">${c.live_left} of ${c.max_uses} bache</span>
        <span class="meter">${esc(until(c.expires_at))}</span>
      </span>
    </li>`).join('');
  $('#codes-blank').hidden = live.length > 0;

  $('#my-payouts').innerHTML = (S.myPayouts || []).map((p) => `
    <li class="entry">
      <span class="entry__code">₹${p.amount}</span>
      <span class="entry__reward">${esc(payoutLabel(p.status))}</span>
      ${p.code_text ? `<span class="entry__note mono">${esc(p.code_text)}</span>` : ''}
      ${p.admin_note ? `<span class="entry__note">${esc(p.admin_note)}</span>` : ''}
      <span class="entry__end"><span class="meter">${esc(clock(p.requested_at))}</span></span>
    </li>`).join('');
  $('#payouts-blank').hidden = (S.myPayouts || []).length > 0;

  $('#wallet-history').innerHTML = (S.walletHistory || []).map((h) => `
    <li class="entry">
      <span class="entry__code">${h.kind === 'credit' ? '+' : '−'}₹${h.amount}</span>
      <span class="entry__reward">${esc(h.label)}</span>
      <span class="entry__end"><span class="meter">${esc(clock(h.at))}</span></span>
    </li>`).join('');
  $('#wallet-blank').hidden = (S.walletHistory || []).length > 0;
}
function payoutLabel(status) {
  return ({
    pending: 'Admin ke paas — wait karo',
    approved: 'Approve ho gaya',
    delivered: 'Code mil gaya',
    rejected: 'Reject ho gaya',
  })[status] || status;
}
/* A pending payout must read as "needs action", not as an inactive grey chip —
   that was the bug when it borrowed state--paused. */
function payoutState(status) {
  return ({ delivered: 'live', pending: 'pending', approved: 'pending', rejected: 'rejected' })[status] || 'paused';
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
    ? '<p class="hint hint--good">Admin khula hai. Upar shield icon se Admin panel kholo.</p>'
    : `<p class="hint">Admin banne ke liye owner ka passphrase chahiye. Sahi passphrase daalne par admin panel khul jayega.</p>
       <span class="field__label">Admin passphrase</span>
       <input type="password" id="pass-input" placeholder="Passphrase daalo" autocomplete="current-password">
       <button class="btn btn--go" type="button" id="pass-go">Admin kholo</button>`;
}

function renderAdmin() {
  const s = S.stats;
  const cells = [
    [s.codes_live, 'live codes'], [s.codes_total, 'total codes'],
    [s.redeemed, 'redeemed'], [s.redeemed_today, 'redeemed today'],
    [s.pending, 'payouts pending'], [s.paid_out, '₹ paid out'],
    [s.credited, '₹ credited'], [s.people, 'people'],
  ];
  $('#admin-stats').innerHTML = cells.map(([n, k]) =>
    `<div class="stat"><div class="stat__n">${n ?? 0}</div><div class="stat__k">${esc(k)}</div></div>`).join('');
  /* Community scoping on a new code. The owner can drop a code anywhere; an
     empty option means "any community" (legacy, visible to everyone). */
  const sel = $('#code-community');
  if (sel && sel.options.length === 0) {
    sel.innerHTML = '<option value="">Sabhi communities (kisi se bhi claim)</option>' +
      S.communities.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  }

  const st = (c) => 'state--' + c.state.replace(' ', '');
  $('#admin-codes').innerHTML = S.adminCodes.map((c) => `
    <li class="entry entry--admin">
      <span class="entry__code">${esc(c.code)}</span>
      <span class="entry__reward">${esc(c.reward)}${c.value ? ` · ₹${c.value}` : ''}</span>
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

  /* Payout queue: admin delivers the real Google Play code, or rejects (refunds). */
  const rules = S.payoutRules || {};
  const rf = $('#rules-form');
  rf.min_payout.value = rules.min ?? '';
  rf.payout_step.value = rules.step ?? '';
  rf.payout_note.value = rules.note ?? '';
  $('#admin-payouts').innerHTML = (S.allPayouts || []).map((p) => `
    <li class="entry entry--admin entry--${esc(p.status)}">
      ${av(p.user, p.hue, 'av--sm')}
      <span class="entry__reward"><b>${esc(p.user)}</b> — ₹${p.amount}</span>
      ${p.note ? `<span class="entry__note">"${esc(p.note)}"</span>` : ''}
      ${p.code_text ? `<span class="entry__note mono">code: ${esc(p.code_text)}</span>` : ''}
      ${p.admin_note ? `<span class="entry__note">${esc(p.admin_note)}</span>` : ''}
      <span class="entry__end">
        <span class="state state--${payoutState(p.status)}">${esc(p.status)}</span>
        <span class="meter">${esc(clock(p.requested_at))}</span>
        ${p.status === 'pending' || p.status === 'approved' ? `
          <span class="entry__acts">
            <button class="icon-btn" type="button" data-payout="deliver" data-id="${p.id}" title="Code deliver karo">${icon('check')}</button>
            <button class="icon-btn icon-btn--danger" type="button" data-payout="reject" data-id="${p.id}" title="Reject (paise wapas)">${icon('x')}</button>
          </span>` : ''}
      </span>
    </li>`).join('') || '<li><p class="blank">Abhi koi request nahi.</p></li>';
}
/* -------------------------------------------------------------- navigation */

const VIEWS = { inbox: 'v-inbox', community: 'v-community', thread: 'v-thread', status: 'v-status', codes: 'v-codes', you: 'v-you', admin: 'v-admin' };
const TITLES = { status: 'Status', codes: 'Wallet', you: 'You', admin: 'Admin panel' };
const MARK = '<span class="mark" aria-hidden="true"><svg viewBox="0 0 32 32"><g fill="none" stroke="currentColor" stroke-width="1.6"><rect x="7" y="7" width="18" height="18"/><rect x="7" y="7" width="18" height="18" transform="rotate(45 16 16)"/><circle cx="16" cy="16" r="4.2" stroke-width="2"/></g></svg></span>';
const isDesktop = () => window.matchMedia('(min-width: 900px)').matches;

function updateStage(view) {
  const desktop = isDesktop();
  for (const [k, id] of Object.entries(VIEWS)) {
    const el = document.getElementById(id);
    if (!el) continue;
    const show = k === view || (desktop && k === 'inbox');
    el.hidden = !show;
    el.style.display = show ? '' : 'none';
  }
  const hint = $('#pane-hint');
  if (hint) hint.hidden = !(desktop && view === 'inbox');
}
function go(view) {
  S.view = view;
  updateStage(view);
  const bar = $('#bar-id'), acts = $('#bar-act');
  bar.innerHTML = ''; acts.innerHTML = '';
  $('#btn-back').hidden = !(view === 'thread' || view === 'community');
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
      await refresh(); go('inbox');
    };
    $('#act-menu').onclick = () => chatMenu(c);
  } else if (view === 'community') {
    const com = S.community;
    bar.innerHTML = com
      ? `${av(com.name, com.hue, 'av--sm')}
         <span><span class="bar__name">${esc(com.name)}</span><span class="bar__sub">${com.member_count} members · ${com.groups.length} groups</span></span>`
      : `${MARK}<span class="wordmark">Community</span>`;
    if (com && (com.role === 'owner' || com.role === 'admin')) {
      acts.innerHTML = `<button type="button" id="act-ann" aria-label="Announce karo">${icon('megaphone')}</button>`;
      $('#act-ann').onclick = () => openAnnounce();
    }
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

  if (view === 'inbox') renderInbox();
  if (view === 'community') renderCommunity();
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
    me: data.me, communities: data.communities || [], chats: data.chats, statuses: data.statuses, codes: data.codes,
    mine: data.my_redemptions, stats: data.stats, ledger: data.ledger, people: data.people,
    wallet: data.wallet || null, walletHistory: data.wallet_history || [],
    myPayouts: data.my_payouts || [], allPayouts: data.all_payouts || [],
    payoutRules: data.payout_rules || null,
  });
  if (S.me.is_admin) {
    const { data: a } = await api('admin/codes');
    S.adminCodes = a.codes || [];
    S.ledger = a.ledger || [];
    S.stats = a.stats || S.stats;
    const { data: p } = await api('admin/payouts');
    S.allPayouts = p.payouts || [];
    S.stats = p.stats ? { ...S.stats, ...p.stats } : S.stats;
  }
  if (S.view === 'inbox') renderInbox();
  if (S.view === 'community') {
    const { data: c } = await api(`communities/${S.communityId}`);
    if (c.community) { S.community = c.community; }
    const { data: k } = await api(`communities/${S.communityId}/codes`);
    S.communityCodes = k.codes || [];
    renderCommunity();
  }
  if (S.view === 'codes') renderCodes();
  if (S.view === 'status') renderStatus();
  if (S.view === 'admin') renderAdmin();
  if (S.view === 'you') renderYou();
  renderCounts();
}

function renderCounts() {
  const tab = $('#tabs button[data-go="inbox"]');
  if (!tab) return;
  const old = $('.count', tab);
  if (old) old.remove();
  /* unread across community groups and DMs both — the inbox tab is the only badge */
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
    await refresh(); go('inbox');
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
  $('#btn-back').onclick = () => {
    if (S.view === 'community') { S.chatId = null; go('inbox'); refresh(); return; }
    /* going back from a group inside a community returns to that community, not the root */
    const chat = S.chats.find((c) => c.id === S.chatId);
    S.chatId = null;
    if (chat?.community_id) { openCommunity(chat.community_id); return; }
    go('inbox'); refresh();
  };
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-go]');
    if (b) go(b.dataset.go);
  });
  $('#q').addEventListener('input', (e) => { S.q = e.target.value; renderInbox(); });
  $('#community-rows').addEventListener('click', (e) => {
    const b = e.target.closest('[data-community]');
    if (b) openCommunity(b.dataset.community);
  });
  $('#chat-rows').addEventListener('click', (e) => {
    const b = e.target.closest('[data-chat]');
    if (b) openChat(b.dataset.chat);
  });
  for (const id of ['#com-ann', '#com-groups']) {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('[data-chat]');
      if (b) openChat(b.dataset.chat);
    });
  }
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
  /* ---- wallet: request a Google Play payout ---- */
  $('#amount-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-amount]');
    if (!b) return;
    $('#payout-form').amount.value = b.dataset.amount;
    $$('#amount-chips .chip').forEach((c) => c.classList.toggle('is-on', c === b));
  });
  $('#payout-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target), box = $('#payout-msg');
    const r = await api('wallet/request', {
      method: 'POST',
      body: { amount: Number(fd.get('amount')), note: fd.get('note') },
    });
    box.hidden = false;
    box.className = 'hint ' + (r.ok ? 'hint--good' : 'hint--bad');
    box.textContent = r.data.message || (r.ok ? 'Request chala gaya.' : 'Request nahi gaya.');
    if (r.ok) { e.target.reset(); $$('#amount-chips .chip').forEach((c) => c.classList.remove('is-on')); await refresh(); }
  });
  /* ---- community codes: owner adds, toggles, deletes ---- */
  $('#com-code-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target), box = $('#com-code-msg');
    const r = await api(`communities/${S.communityId}/codes`, {
      method: 'POST',
      body: {
        code: fd.get('code'), reward: fd.get('reward'), value: Number(fd.get('value')),
        maxUses: Number(fd.get('maxUses')), hours: Number(fd.get('hours')),
      },
    });
    box.hidden = false;
    box.className = 'hint ' + (r.ok ? 'hint--good' : 'hint--bad');
    box.textContent = r.ok ? 'Code lag gaya. Members Wallet me claim kar sakte hain.' : (r.data.message || 'Code nahi laga');
    if (r.ok) { e.target.reset(); await openCommunity(S.communityId); await refresh(); }
  });
  $('#com-codes').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-com-code]');
    if (!b) return;
    const { comCode, id, code, on } = b.dataset;
    if (comCode === 'copy') {
      try { await navigator.clipboard.writeText(code); toast('Code copy ho gaya'); }
      catch { toast(code); }
      return;
    }
    if (comCode === 'toggle') {
      await api(`communities/${S.communityId}/codes/${id}/active`, { method: 'POST', body: { active: on !== '1' } });
      await openCommunity(S.communityId); await refresh(); return;
    }
    if (comCode === 'del') {
      const yes = await sheet('Code delete karo?', [{ label: code, sub: 'Isse hamesha ke liye hata dega', icon: 'trash' }]);
      if (!yes) return;
      await api(`communities/${S.communityId}/codes/${id}`, { method: 'DELETE' });
      await openCommunity(S.communityId); await refresh();
    }
  });
  /* ---- admin: payout rules + deciding requests ---- */
  $('#rules-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target), box = $('#rules-msg');
    const r = await api('admin/payout-rules', {
      method: 'POST',
      body: {
        min_payout: Number(fd.get('min_payout')), payout_step: Number(fd.get('payout_step')),
        payout_note: fd.get('payout_note'),
      },
    });
    box.hidden = false;
    box.textContent = r.ok ? 'Rules save ho gaye.' : 'Rules save nahi hue';
    if (r.ok) { S.payoutRules = r.data.rules; await refresh(); }
  });
  $('#admin-payouts').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-payout]');
    if (!b) return;
    const { payout, id } = b.dataset;
    if (payout === 'deliver') {
      const p = (S.allPayouts || []).find((x) => x.id === id);
      const code = await askText(`₹${p ? p.amount : ''} ka Google Play code`, {
        label: `${esc(p ? p.user : '')} ko ye code milega`,
        placeholder: 'XXXX-XXXX-XXXX-XXXX',
        confirm: 'Deliver karo',
      });
      if (!code) return;
      const r = await api(`admin/payouts/${id}`, { method: 'POST', body: { action: 'deliver', code_text: code } });
      toast(r.data.message || (r.ok ? 'Deliver ho gaya' : 'Nahi ho paya'), !r.ok);
      if (r.ok) await refresh();
      return;
    }
    if (payout === 'reject') {
      const why = await askText('Request reject karo?', {
        label: 'Kyun reject kar rahe ho (paise wapas wallet me jayenge)',
        placeholder: 'Galat amount maanga / duplicate request',
        multiline: true,
        confirm: 'Reject karo',
      });
      if (!why) return;
      const r = await api(`admin/payouts/${id}`, { method: 'POST', body: { action: 'reject', admin_note: why } });
      toast(r.data.message || (r.ok ? 'Reject ho gaya' : 'Nahi ho paya'), !r.ok);
      if (r.ok) await refresh();
    }
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
        code: fd.get('code'), reward: fd.get('reward'), value: Number(fd.get('value')), note: fd.get('note'),
        maxUses: Number(fd.get('maxUses')), hours: Number(fd.get('hours')),
        communityId: fd.get('communityId') || null,
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
  go('inbox');
  window.addEventListener('resize', () => updateStage(S.view));
  live();
  document.body.dataset.ready = '1';
})();
