# RT ZENE — design plan

## 0. Subject line (doctrine §1)

- **What it is:** RT ZENE, a chat app that behaves like WhatsApp — chat list, one-to-one chat,
  groups, status, blue ticks, search — plus a redeem-code counter built into it.
- **Who it is for:** a Hindi/Hinglish gaming audience on phones, and one admin (the owner) who
  hands out redeem codes.
- **The page's main job:** open a chat that feels instantly familiar, and reach the redeem
  code desk in one tap.

Confirmed wording from the brief: "WhatsApp jaisa sem tu sem" — same feel. Behaviour is
copied. Name and logo are not (trademark). Own identity: **RT ZENE**.

---

## 1. Pass 1 — plan

### Colour (6 named values)

| token            | hex       | job                                                        |
|------------------|-----------|------------------------------------------------------------|
| `--graphite`     | `#0E1114` | chat canvas, app background                                 |
| `--slate`        | `#171B20` | bars, panels, sheets, incoming bubbles                      |
| `--pine`         | `#1F4D45` | outgoing bubbles — quiet, deep, carries no attention        |
| `--marigold`     | `#E8B84B` | the one accent: ticks, primary buttons, live-code marker     |
| `--chalk`        | `#EDEFF2` | primary text                                                |
| `--ash`          | `#8E97A3` | secondary text, timestamps, dividers                        |

Marigold is the single accent and it is spent in exactly four places. Nothing else is
saturated. There is no gradient anywhere; every surface is a flat fill.

### Type (two families, each with a job)

- **Onest** 400 / 500 / 600 / 800 — every piece of UI text: names, messages, headings,
  buttons, the wordmark. Chosen because it stays legible at 13–15 px on a phone and has a
  humanist warmth that a pure grotesque lacks.
- **Martian Mono** 400 / 500 — redeem codes, timestamps, and counts only. Fixed width is
  functional here: codes are alphanumeric and get read character by character, and tabular
  numerals keep ledgers aligned.

Self-hosted as `woff2` in `public/fonts/`. No CDN call at runtime.

### Layout

Single-column mobile app shell, full height, 56 px header, scrolling content, 60 px bottom
tab bar respecting the safe-area inset. At ≥ 900 px it becomes a two-pane rail + conversation
split. Text is left-aligned everywhere. Bubbles go right for outgoing, left for incoming.

```
mobile                          desktop (>=900px)
┌───────────────────────┐       ┌──────────┬──────────────────────┐
│ ⬤ RT ZENE   ⌕    ⋮     │ 56    │ ⬤ RT ZENE │  Ava          call   │ 56
├───────────────────────┤       │ ⌕        ├──────────────────────┤
│ Ava       ·  9:41     │       │ ─────    │                      │
│ last message text...  │ 72    │ Ava  9:41│     (message)        │
├───────────────────────┤       │ ...      │  (message)     ✓✓    │
│ Ravi      ·  8:02     │       │          ├──────────────────────┤
│ code mil gaya bhai    │       │          │  ▸ type...      send │ 56
├───────────────────────┤       │          │                      │
│      (jaali canvas)   │       │──────────│                      │
├───────────────────────┤       │ Chats St │                      │
│ Chats Status Codes You│ 60    └──────────┴──────────────────────┘
└───────────────────────┘
```

### Principles (what makes this different)

1. The wallpaper is a **jaali lattice** — a thin Indian stone-screen motif drawn as an inline
   SVG, repeated at ~4 % opacity. WhatsApp ships a doodle; this ships a lattice. It is the one
   memorable element and it is barely visible on purpose.
2. **The redeem desk is a counter, not a card grid.** Codes sit in a hairline ledger with a
   perforated left edge. Every column on that row carries information: code, reward, state,
   expiry, who took it. No icon, no illustration, no card.
3. **Dark by default, not dark as an afterthought.** Outgoing bubbles are deeper than incoming
   ones, which is the opposite of how WhatsApp reads — the owner's own words recede and the
   other person's arrive. Marigold ticks still confirm delivery at a glance.
4. The **Codes tab is first class** in the tab bar. The point of the site is handing out codes,
   so it does not live behind a menu.

---

## 2. Pass 2 — review against the brief and the doctrine

Checked each risk honestly.

| Risk                                                             | Verdict  | Change made                                                                                         |
|------------------------------------------------------------------|----------|-----------------------------------------------------------------------------------------------------|
| Dark canvas + bright accent is doctrine §3.2 (the AI default)     | **Hit**  | Outgoing bubbles moved to deep pine `#1F4D45` and the accent restricted to four jobs. Marigold is amber, not acid-green or red-orange. |
| "Same to same WhatsApp" invites copying their palette             | **Hit**  | Geometry and behaviour kept identical; colour is entirely original. No teal, no `#25D366`, no doodle. |
| Rounded cards everywhere is §3.4                                   | **Hit**  | Radius limited to 3 values, all small (2 / 10 / 18). Bubble tail is drawn, not a rounded rectangle. Admin panel is a table, not cards. |
| Bottom tab + top bar is default app chrome                        | **Kept** | Doctrine §3.7 permits the default stack when the content truly is that. A chat app genuinely is chat list + conversation + tabs. |
| ALL-CAPS tracked labels above headings is §3.5                     | **Hit**  | Removed. Section titles are sentence case, 13 px, `--ash`. Tab labels are sentence case. |
| Arrows appended to every link is §3.5                             | **Hit**  | Removed. Buttons say what they do: "Send code", "Redeem", "Copy".                                  |
| Fade-and-slide-up on every section is §3.6                        | **Hit**  | Only two entrance motions exist: the app shell's first paint, and a message bubble landing in the thread. Both answer "what changed". |
| Emoji as icons is §3.6                                            | **Hit**  | All icons are inline SVG on a 24 px grid, 1.6 px stroke.                                             |
| "Welcome to" / "Elevate your" / "seamless" copy is §3.6            | **Hit**  | All copy written from the user's side. Empty states tell you what to do next.                        |

**Remove one more element (§7):** the unread badge was going to sit on every tab. Cut. A tab
shows a count only when the count is greater than zero.

**One-line check:** the memorable thing is the jaali canvas; the marigold accent and the
perforated code ledger are the only other raised voices. Everything else is quiet.

---

## 3. Build order (§11)

1. Subject line — done above.
2. Two-pass plan — done above.
3. Shape — this document.
4. Craft — `server.js`, `lib/db.js`, `public/`.
5. Detect — run the doctrine's blocked-pattern scan, fix, re-run.
6. Audit → critique → polish on the running app.
7. §10 finish checklist — answered at the end of `README.md`.
