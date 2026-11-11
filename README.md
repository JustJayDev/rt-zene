# RT ZENE

A chat app that works like WhatsApp — chat list, one-to-one chat, groups, status,
delivery ticks, search — with a redeem-code desk built into it and an admin panel to
run that desk.

Runs on the phone. No cloud account, no build step, no dependencies.

---

## Run it

```bash
cd /sdcard/NightForge/projects/rt-zene
node server.js
```

Then open **http://127.0.0.1:5170** in the browser.

The server binds to `127.0.0.1` only, so nothing on your network can reach it.
Stop it with Ctrl+C.

**Admin passphrase** (first run only, change it whenever you like):

```bash
RTZENE_ADMIN_PASS=yournewpass node server.js
```

The default on a fresh database is `rtzene`. You open the admin panel from the
**You** tab.

---

## What is in it

### Chat
- Chat list with search, last message, unread count, and pinned chats at the top
- One-to-one chats and group chats
- Message bubbles with a tail, day dividers, and delivery ticks — ticks turn amber when read
- Status updates that disappear after 24 hours
- Live updates over Server-Sent Events, so two open windows stay in step without refreshing

### Communities
- Communities hold channels and groups, the way a WhatsApp community does
- Each community has an **Announcements** channel that only the owner can post in
- Every other channel is a normal group where all members can talk
- The inbox lists your communities first, then your one-to-one chats
- A community hub shows its announcements, groups, and member list
- Non-owners get a locked composer in Announcements instead of a text box
### Redeem codes
- A **Codes** tab with a box to type a code in
- Each code carries a rupee **value**, plus an optional note, a use limit, and an expiry date
- A code can only be taken **once per person** — a second attempt is refused
- Expired, paused, and used-up codes are refused with a reason written in plain language
- You only see codes from communities you belong to
- "Tumne kya liya" — your own redemption history, always visible
- A code can be sent **into a chat** as a message with a claim button on it
### Wallet and Google Play payouts
- Claiming a code **credits its rupee value to your wallet**
- The wallet balance is never a stored number — it is always the sum of every credit minus every debit, so it cannot drift
- Balance card shows what you have, what is already requested and pending, and what you can still request
- Once your balance reaches the owner's **minimum**, you can request a **Google Play code**
- Requests must land on the owner's **denomination steps** (for example multiples of ₹100)
- A pending request is **debited immediately**, so the same rupees cannot be requested twice while waiting
- The owner either delivers a real Play code (it appears on your request) or rejects it with a reason and the rupees are **refunded to your wallet**
- Full wallet history: every credit, debit, and refund with its reason and community name
### Owner code management
- Owner adds a code from the community hub, with a rupee value attached
- Owner can pause, copy, or delete their own codes
- Members cannot add codes — the server refuses with `owner_only`
### Admin panel
- Stats: live codes, total codes, redemptions, redemptions today, messages, people
- Payout stats: pending payouts, rupees paid out, rupees credited to wallets
- **Payout queue**: every open request with who asked, how much, and their note
- Deliver a request by pasting the real Google Play code — it is shown to that user only
- Reject a request with a reason, which automatically refunds the rupees to that wallet
- Payout rules form: minimum amount, denomination step, and the note shown to requesters
- Create a code with a rupee value, a note, a use limit, and an expiry in hours
- Pause and resume a code without deleting it
- Send a code into any chat as a message
- Copy a code to the clipboard
- The full ledger: who took what, when, where, and for how much
- Duplicate codes are refused so nobody reuses a name by accident

---

## How it is built

**Plain Node 22 + built-in `node:sqlite`. Zero dependencies.**

I checked the alternatives before choosing. What was on the table:

- **Next.js / React** — the install alone is heavier than the entire app, and it brings a
  build step to a phone. Nothing here needs component hydration.
- **Express + better-sqlite3** — both are well made, but each is a native or tree-heavy
  install, and `node:sqlite` is now built into Node itself. Fewer moving parts to break
  on a phone.
- **A hosted backend** — not needed yet, and it would mean an account and a bill before
  the first visitor arrives.

What I actually used, and why:

| Piece | Choice | Reason |
|---|---|---|
| Server | `node:http` | The app has 20 routes. A framework would be more code, not less. |
| Database | `node:sqlite` | Ships with Node 22. No install, no compile, WAL mode, one file. |
| Realtime | Server-Sent Events | Updates only travel server → client. WebSockets would be a heavier tool for the same job. |
| Front end | Plain HTML/CSS/JS | No framework, no build step, loads instantly, easy to hand to anyone. |
| Fonts | Self-hosted `woff2` | No runtime request to Google. Works offline. |

```
rt-zene/
├── server.js              routes, SSE, static files
├── lib/db.js              schema, queries, all writes
├── public/
│   ├── index.html         the whole app shell
│   ├── app.css            the design system
│   ├── app.js             the client
│   ├── favicon.svg
│   └── fonts/             Onest + Martian Mono, latin subsets
├── data/rtzene.db         created on first run
└── DESIGN.md              the design plan and the review of it
```

---

## Security

- Binds to loopback only
- Admin routes require an admin account; non-admins get 403
- The admin passphrase is stored as a `scrypt` hash, never in plain text
- Chat access is checked on read **and** write — you cannot post into a chat you are not in
- Sessions are `HttpOnly`, `SameSite=Lax` cookies
- All user content is escaped before it reaches the DOM
- Path traversal is blocked on static files
- Request bodies are capped at 256 KB

**Not built yet, on purpose:** these are demo accounts with no passwords. Anybody who can
reach the port can switch between them. That is fine for a prototype on your own phone.
Before this goes on the internet it needs real sign-in — see "Before this goes public".

---

## Before this goes public
1. Real sign-in (password or magic link) — the `POST /api/session` switcher must go.
2. Put it behind HTTPS, and set `Secure` on the session cookie.
3. Serve the app from a real host; keep SQLite, or move to Postgres if more than one
   server process is ever needed.
4. Rate-limit `/api/redeem`, otherwise a code can be brute-forced by trying everything.
5. Move the admin passphrase into an environment variable, not the seed default.
6. **This app now moves real money.** Before anyone outside your test group can request a
   payout, two things must exist that a database cannot give you:
   - a person manually buying the Google Play codes and typing them in — the app records
     a delivered code but it cannot buy one, so the rupee value you put on a code is a
     promise you are making out of your own pocket
   - a written rule for disputes: what happens if a user says the code did not work
7. Cap what one account can earn. Right now a code's value is set only by the owner, and
   nothing limits how many codes a single user can claim. Set a monthly ceiling before
   real users arrive, or one leaked code list can drain you.
8. Keep an off-device copy of the database. `data/rtzene.db` is the only record of every
   credit and every delivered payout; if the phone dies, the balances are gone.

---

## Design

The visual direction, the palette, the type choices, and the review of them live in
`DESIGN.md`. Summary of the decisions that made this not look like a template:

- Dark canvas, **one** amber accent (`#E8B84B`), spent in exactly four places
- Outgoing bubbles sit **deeper** than incoming ones — the opposite of WhatsApp — so the
  other person's words arrive and your own recede. Amber ticks still confirm delivery.
- The wallpaper is a **jaali** lattice drawn as inline SVG at 4.5% opacity: the one
  memorable element, and it stays almost invisible on purpose
- The code list is a **ledger with a perforated edge**, not a grid of cards
- Zero gradients. Only three corner radii, all small.
- Two typefaces with separate jobs: **Onest** for the interface, **Martian Mono** for
  codes, times, and counts — fixed width because codes are read character by character

---

## Checks that were run

Four scripts live in `/root` on the device. They are deterministic — they either pass or
they name the line that failed.

```bash
node /root/rtzene-contrast.js    # WCAG ratios for all 34 colour pairs
node /root/rtzene-contract.js    # every id/class/icon the client uses actually exists
node /root/rtzene-detect.js      # scans for the AI-made design patterns
bash /root/rtzene-smoke.sh       # 14 live API tests against the running server
```

Last results:

- **Contrast** — all 34 pairs pass. Two were failing and were fixed: the outgoing bubble
  timestamp (4.26:1 → 5.17:1) and the list separator, which was so faint it carried no
  information (1.07:1 → 1.36:1).
- **Contract** — clean.
- **Detector** — 1 finding left, and it is a deliberate exception: the redeem input has
  `text-transform: uppercase`, which is a *data* transform on the code itself, not an
  all-caps label. Kept, with the reason written here instead of silently ignored.
- **Smoke** — 14/14. This run caught a real hole: the message-write route was checking
  membership on read but not on write, so any signed-in account could post into any chat.
Fixed, and retested.
### Wallet and payout checks
The wallet layer has its own two probe scripts, run against a live server with a fresh seed:
```bash
bash /tmp/rtz-test.sh          # member side: claim, balance, request, refusals
bash /tmp/rtz-admin-test.sh    # admin side: queue, deliver, reject, refund, rules
```
Results:
- Claiming a code credits exactly its rupee value — Jay ₹0, Ava ₹750, Arjun ₹150
- A user only sees codes from communities they belong to; claiming an outside code
  returns `not_member`
- Only the community owner can add a code — a member gets `owner_only`
- A request below the minimum returns `not_enough`, a request off the denomination step
  returns `bad_step`, and a request over available balance is refused
- Pending money is debited at request time, so it cannot be requested twice while waiting
- Deliver writes the real Play code and marks the request `delivered`; delivering twice
  returns `done`, delivering with no code returns `no_code`
- Reject refunds the exact amount back to the wallet (Ravi 200 → 500) and writes a
  `Payout reject — paise wapas` credit, so the ledger explains itself
- Rules survive a round trip: min ₹500 / step ₹50 instantly changed the only chip offered
  to a ₹500 balance
- Stats react to all of it: pending, delivered, and ₹ paid out all move with the queue

### What these checks do **not** cover

I did not see the app running. Visual confirmation still needs a human eye — that is why
the browser preview is left running for you.

---

## Design doctrine checklist (section 10)

- **Does it match the subject, audience, and job?** Yes: familiar chat behaviour for a
  Hindi/Hinglish gaming crowd, with the redeem desk one tap away in the tab bar.
- **Any banned pattern present without a reason?** Two, both listed above with reasons.
  "Same to same WhatsApp" was interpreted as *behaviour*, not branding — no WhatsApp name,
  no logo, and none of their colours (`#25D366` and friends are absent, and the detector
  checks for exactly that).
- **One memorable element, rest quiet?** The jaali lattice. Everything else is flat fills,
  hairlines, and the ledger.
- **Motion per section 6?** Two entrance motions only: the shell's first paint, and a
  message landing. Both answer "what changed". `prefers-reduced-motion` is respected, and
  there is a manual "Motion kam karo" switch in the You tab.
- **Works and looks right on a phone?** Built mobile-first and there is a two-pane layout
  above 900 px. Needs your eyes on it.
- **Still look AI-made anywhere?** The three usual tells were removed at the start: no
  purple-blue gradient, no emoji as icons, no "Welcome to". The remaining risk is the one
  this app cannot avoid — it deliberately imitates WhatsApp, so it will read as *WhatsApp*
  rather than as generic AI output. That is the brief, not an accident.
