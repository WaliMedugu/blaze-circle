# Blaze-Grid: Build Plan (InnovateX 2026, Track A)

**Version:** 1.0, 17 Oct 2026 · **Deadline:** 20 Oct (3 build days left) · **Team:** Tensor Labs (pending confirmation)

> **One line for judges:** *Blaze-Grid lets a student pay a campus vendor with zero data on either phone. The vendor is guaranteed to get paid because the money was already set aside by Ecobank. Each payment also builds the student's credit identity.*

---

## 0. The five changes that make this hard to refuse

The draft plan had good ideas but some loopholes a technical judge would find quickly. These changes fix them:

| # | Draft said | Problem a judge will raise | Refined design |
|---|---|---|---|
| 1 | "₦5,000 max offline **exposure**" | If the bank can't see the balance, who pays the vendor if the student is broke? That's unsecured credit risk. | **Blaze Pocket:** while online, the student moves up to ₦5,000 into a pocket, and Ecobank puts a **lien** on it. Offline spending only comes from pre-reserved money, so the vendor is **guaranteed**. The bank's credit exposure on honest use is **₦0**. This is the same model as India's UPI Lite. |
| 2 | "HMAC-SHA256 signed offline payloads" | HMAC uses a *shared* secret. To verify offline, the vendor needs the secret, which means the vendor can **forge** payments. | **Asymmetric signatures (ECDSA P-256, WebCrypto).** The student's phone signs. The vendor's phone checks the signature against a **bank-signed Pocket Certificate** using Ecobank's public key, which ships inside the app. No shared secrets. HMAC stays server-side only. |
| 3 | "Token expires in 90 s" | Offline phones have unsynced clocks, so whose clock counts? | The **vendor's phone creates a one-time nonce** and starts the 90-s window on **its own clock**. The voucher must echo that nonce, so clock skew doesn't matter and a voucher can't be replayed to another sale. |
| 4 | "Path B: background USSD" | A PWA (and even most native apps) **cannot send USSD silently.** That's impossible. | **Path B is removed.** Two paths only: online and offline QR. SMS/USSD go on the roadmap slide. Never say "background USSD." |
| 5 | Four modules plus logistics in 3 days | Scope creep is the main risk, and a half-working demo loses. | Build **Pay (online + offline)**, **Merchant mode**, the **Risk Console**, **Proof**, and **Circles-lite**. **Blaze Route and Whistle (audio) are removed** and appear only as roadmap. |

**Bonus simplification:** online and offline payments use the **same signed voucher format**. "Online" is just a voucher submitted immediately. That gives one code path and one state machine, so there's less to build and less to break.

---

## 1. Feasibility verdicts

### ✅ Possible and in scope

| Capability | How |
|---|---|
| Installable PWA that opens with no data | Next.js + Serwist service worker caches the app shell. The app must be opened once while online (do this before the demo). |
| Phone-to-phone offline payment | Two-way **QR**: the vendor shows a request QR, the student scans it and shows a voucher QR, and the vendor scans that. Uses only the cameras. Works on Android Chrome and iOS Safari 14+. |
| Offline signature verification | WebCrypto ECDSA P-256 (supported in every modern browser, including iOS). Keys are generated **non-extractable** and stored in IndexedDB. |
| Offline queue + sync | IndexedDB queue. Sync runs on app focus or reconnect, plus on a heartbeat. (The Background Sync API isn't on iOS, so don't rely on it.) |
| Real connectivity detection | `navigator.onLine` alone can't be trusted (it reports "Connected" on captive or no-internet networks). Use a 3-s timeout ping to `/api/health` every 5 s. |
| Atomic, idempotent settlement | A Postgres function `settle_voucher()` with a row lock and `UNIQUE(cert_id, counter)`. |
| Live judge dashboard | Supabase Realtime streams the voucher state changes. |
| Circle pledge-backed credit (simulated disbursement) | Pledges are liens on members' mock accounts. The loan is fully secured at the start. |
| Trust score | Rule-based and **explainable** (no ML black box), so judges can see each factor. |

### ⚠️ Possible but stretch or explain-only

| Capability | Reality |
|---|---|
| Real Ecobank API | Build an `EcobankAdapter` interface with a `MockBank` implementation. If sandbox keys arrive, swap the implementation. Label the demo "Ecobank sandbox simulation." |
| Dead-Phone Proxy | Works only when the **vendor's phone has data** and a Circle friend is online. If the network is also down, a friend nearby pays by offline QR instead. Present it honestly as a *battery* rescue, not a *network* rescue. |
| Web Push to friend's phone | iOS needs the PWA installed to the home screen. In the demo, use Realtime while the app is open. |

### ❌ Not possible: remove from pitch and slides

- "Background USSD" from a web app.
- Bluetooth phone-to-phone in a PWA. Web Bluetooth can't act as a peripheral, and iOS has no Web Bluetooth.
- NFC phone-to-phone in a PWA. Web NFC is Android-only, tags-only, with no card emulation.
- "Whistle & Pay" ultrasound. Browser audio sends about 8–30 bytes/s, so it's too slow for a signed voucher and unreliable in noisy rooms.
- SMS fallback. It needs a provisioned short code and someone to tap Send, and it adds nothing to the demo.
- Blaze Route deliveries. It's a separate logistics business.
- "Zero fraud", "zero default", "works forever offline". Use bounded-risk language instead (§3.4).
- Real NIBSS Direct Debit in 3 days. It isn't needed anyway: an Ecobank-to-Ecobank debit is an internal standing instruction.
- Real money or real KYC. Prototype only.

---

## 2. Refined product scope (MVP)

| Module | In the demo | Out |
|---|---|---|
| **Blaze Relay** (engine) | Pocket certs, voucher sign/verify, offline queue, sync, settlement state machine, risk rules | Real telecom path |
| **Blaze Flow** (commerce) | Student pay, vendor charge, vendor sales list | Inventory, receipts printing |
| **Blaze Circles** | Create circle, invite by `$BlazeTag`, pledge, **Pay-for-a-friend** rescue, **credit request with 2 approvals → disbursed** | Real lending, interest engine |
| **Blaze Proof** | Activity timeline + Trust Score (0–100) with factor breakdown | Bureau reporting |
| **Risk Console** (judge screen) | Live voucher feed, **attack buttons** (replay, expired, forged, over-limit), all rejected live | — |
| **Blaze Route** | Slide only | Everything |

---

## 3. How the core works (the Relay protocol)

### 3.1 Objects

```
PocketCert  (issued online by Ecobank server, signed with BANK private key)
  { v, cid, uid, tag, did, pk(device pubkey), lim (≤ 5000), iat, exp (iat + 72h) } + bankSig

ChargeRequest  (vendor → student; QR)
  { mid, mname, amt, rn (16-byte random nonce), t }

Voucher  (student → vendor; QR)
  { cid, ctr (1..3), amt, mid, rn, spentAfter } + deviceSig   [+ PocketCert attached]
```

Encoding: CBOR → base45 → QR (about 400 chars, QR v15). It scans reliably from a phone screen at full brightness.

### 3.2 The offline payment, step by step

1. **Vendor** types ₦3,500 → app shows a **Request QR** and starts its **90-s timer**.
2. **Student** scans it → confirm screen shows vendor name, amount, and an "Offline: paid from Blaze Pocket" badge → enters **Blaze PIN**.
3. Student phone checks locally: `ctr < 3`, `spentAfter ≤ lim`, cert not expired → **signs** the voucher → shows the **Voucher QR**. The pocket balance drops immediately and the pending count goes up.
4. **Vendor** scans it. The vendor phone verifies, all offline:
   1. `bankSig` valid on the PocketCert (bank public key is in the app)
   2. cert not expired
   3. `deviceSig` valid against `cert.pk`
   4. `mid` = me, `rn` = my open nonce, `amt` = my requested amount
   5. scanned within 90 s of *my* request (vendor's clock only)
   6. `(cid, ctr)` not seen before on this device
5. Vendor sees a big green **"₦3,500 RECEIVED · Guaranteed by Ecobank · settles when online"**.
6. Whichever phone gets signal first uploads. **Only the vendor's upload settles the payment.** The student's upload is an early-warning signal and lets the bank reconcile sooner.

### 3.3 State machine (matches the blueprint names)

```
SIGNED (student) ──scan──▶ PENDING_SETTLEMENT (vendor holds, offline)
   ──upload──▶ RECEIVED_VALIDATED (server re-verifies everything)
   ──atomic ledger move: pocket lien → vendor──▶ SETTLED_CONFIRMED
Side exits: REJECTED{bad_sig | replay | expired | over_limit | cert_revoked}
            UNCLAIMED_RELEASED (vendor never submitted within 72h → money back to student)
```

### 3.4 Risk rules: what's bounded and how

| Bound | Value | What it actually protects |
|---|---|---|
| Pocket size | ≤ ₦5,000 | The most that can ever be spent offline per device. Pre-funded, so the bank isn't lending it. |
| Offline vouchers before sync | 3 | Limits how stale the pocket state can get. |
| Request→scan window | 90 s (vendor clock) | Stops replayed or screenshotted vouchers. |
| Pocket cert lifetime | 72 h | Forces a regular sync. Unused pocket money returns to the main balance automatically. |
| Vendor claim window | 72 h after cert expiry | Vouchers that were shown but never scanned never settle, and the money is released. |

**Worst case (judges will ask): a hacked phone clones its pocket and spends it twice.** The same `(cid, ctr)` signed for two vendors is *cryptographic proof* of fraud. Policy:
- **The vendor is always paid** for a valid voucher accepted within the rules.
- The overspend is recovered from the student's main account under the account terms.
- Offline mode is revoked.
- The account is KYC'd (BVN/NIN), so the person is identifiable.

Maximum loss is bounded at ≤ ₦5,000 × devices per identity, minus whatever is in the main balance. This is **bounded risk, not zero risk**, and you should say exactly that.

### 3.5 Online path

It's the same voucher, uploaded instantly, and it debits the **main balance** instead of the pocket. That means the online and offline demos run the same code.

---

## 4. Circles and credit (BlazeCircle, made bank-safe)

- **Circle:** 3–6 students who invite each other by `$BlazeTag`.
- **Pledge:** each member pledges, for example, ₦2,000–₦10,000, which becomes a **lien** on their account (they can't spend it, but it stays theirs).
- **Credit request:** up to `min(₦30,000, pledgePool × collateralFactor)`. It needs **2 Circle approvals** (PIN). Ecobank disburses (mocked) into the main account. The student can then move it into the Pocket and **spend it offline**. That's how BlazeCircle and Blaze-Grid connect.
- **Collateral factor ladder:** new circle 1.0× (fully secured, so ~zero bank risk) → 1.5× after 3 on-time repayments → 2.0× with a Trust Score ≥ 70. This is how credit grows with Proof, and it's the business story.
- **Repayment:** an auto-debit standing instruction on the due date. If it fails, pledges are drawn pro-rata, and the borrower owes those members (IOUs shown in the Circle). Peer accountability does the collections.
- **Pay-for-a-friend (Dead-Phone rescue):**
  1. The vendor taps "Customer's phone is dead" and enters `$tag`.
  2. The student's Circle members who are online get a request.
  3. The first one to approve with a PIN pays the vendor.
  4. An IOU is recorded, and it auto-settles when the student is back.

  Nobody types a PIN on the vendor's phone, so the vendor can't capture it.
- **Interest and fees:** Ecobank sets them. The demo shows a flat 2% fee placeholder. Avoid promising rates.

---

## 5. Blaze Proof: Trust Score (0–100, explainable)

| Factor | Weight | Signal |
|---|---|---|
| Payment regularity | 25 | Active weeks out of the last 8 |
| Pocket discipline | 20 | No over-limit or rejected vouchers |
| Circle reliability | 25 | On-time repayments, approvals given |
| Network diversity | 15 | Distinct vendors and peers paid |
| Tenure | 15 | Account age (capped) |

The UI shows a gauge, the five factor bars, "How to raise your score" tips, and a timeline of proof events. Sharing with Ecobank's credit team is **opt-in, with consent recorded** (Nigeria Data Protection Act 2023). The exact weights are a team decision; I'll leave that function for you to tune.

---

## 6. UI/UX: screens and flows

**Visual system:** mobile-first, deep navy background and Ecobank-style blue/lime accents (check brand-use rules with the organizers), large tap targets, Naira formatted `₦3,500`. Every money state gets a **color + icon + word**, never color alone:
- 🟢 Settled
- 🟡 Pending (offline)
- 🔴 Rejected

### Student app (bottom nav: Home · Pay · Circle · Proof)

| Screen | Contents and behavior |
|---|---|
| **Onboarding** (4 steps) | (1) Phone/email → OTP (demo: magic link). (2) Pick `$BlazeTag`. (3) "Link Ecobank account" (mock account no., or "Open Xpress account"). (4) Set 4-digit Blaze PIN → the device key is generated silently → "Fund your Blaze Pocket" prompt. |
| **Home** | **Connectivity pill** at the top: `● Online` / `◐ Weak` / `○ Offline: Pocket mode`. **Balance card:** main balance (greyed when offline: "last synced 2m ago") and **Blaze Pocket ₦3,000 / ₦5,000**, with an "Offline-ready ✓ · expires in 2d". Big **Scan to Pay** button, then Receive and Top-up Pocket. A **Pending drawer** shows `2 / 3 offline payments waiting` and expands to a list with statuses. |
| **Pay** | Camera scanner → **Confirm sheet** (vendor, amount, mode badge, pocket remaining after) → PIN pad → online: animated tick, "Paid"; offline: **full-screen Voucher QR**, brightness boosted, 90-s ring countdown, "Show this to the vendor," with a "Cancel" button that voids the voucher locally. |
| **Receive** | Shows my request QR (peer-to-peer uses the same flow as vendors). |
| **Circle** | Circle card (members' avatars, pool ₦), **My pledge** (edit), **Request credit** (amount slider limited to eligibility, purpose chips: Exam fees / Materials / Food / Other), **Approvals inbox** (approve/decline with PIN), **IOUs**. |
| **Proof** | Trust Score gauge, factor bars, tips, timeline (each payment, repayment, and approval as an event), and a "Share with Ecobank" consent toggle. |

### Merchant mode (toggle in profile; separate home)

| Screen | Contents |
|---|---|
| **Charge** | Big numeric keypad → **Show Request QR** with 90-s timer → auto-switches to **Scan customer code** → result screen: huge ✅ **₦3,500 RECEIVED · Guaranteed** or ❌ with a plain reason ("Code expired, ask customer to scan again"). |
| **Sales** | Today's total, list with Settled/Pending badges, "Sync now." |
| **Dead-phone rescue** | Enter `$tag` + amount → waits for a Circle approval → ✅. |

### Risk Console (laptop, projected for judges)

- Live voucher feed (Realtime) moving through the state machine.
- Counters: settled ₦, pending ₦, rejected attempts.
- Pocket exposure gauge.
- **Attack panel:** *Replay voucher*, *Submit expired*, *Tamper amount*, *Fake cert*, *4th offline payment*. Each one is rejected live with its reason.

  This is where you prove the security claims instead of just stating them.

---

## 7. Tech stack & architecture

| Layer | Choice | Why |
|---|---|---|
| App | Next.js 16 (App Router) + TypeScript + Tailwind 4 | One codebase for the PWA, API, and console |
| PWA | Serwist (service worker), web manifest | Offline app shell |
| Offline store | `idb` (IndexedDB) | Keys, cert, queue |
| QR | `qrcode` (generate) + `qr-scanner` (nimiq; fast, works on iOS) | Proven |
| Crypto | WebCrypto ECDSA P-256 / SHA-256; `cbor-x`; `base45` | Native, no exotic dependencies |
| Backend | Next.js Route Handlers on Vercel | One deploy target |
| DB/Auth/Realtime | Supabase (Postgres, RLS, Realtime) | Agreed by the team |
| Bank | `EcobankAdapter` interface → `MockBank` (double-entry ledger in Postgres) | Swappable for the real sandbox |

**Decision: drop the separate Python relay engine.** A second runtime and a second deploy in 3 days adds risk and no demo value. `blaze_relay_engine` becomes a TypeScript module (`lib/relay/`) shared by the client verifier and the server settler. Same logic on both sides means fewer bugs. If the team wants Python on a slide, show it as the production scoring service.

```
blaze-grid/
  app/
    (student)/home, pay, receive, circle, proof
    merchant/charge, sales, rescue
    console/                # judge dashboard
    api/ health, pocket/issue, vouchers/submit, circles/*, loans/*, rescue/*
  lib/
    relay/   cert.ts voucher.ts verify.ts rules.ts states.ts   # shared client+server
    offline/ db.ts queue.ts sync.ts connectivity.ts
    bank/    adapter.ts mock.ts
    proof/   score.ts
  supabase/migrations/      # schema + settle_voucher() + RLS
```

### Data model

| Table | Key columns |
|---|---|
| `profiles` | id, tag (unique), name, is_merchant, trust_score |
| `bank_accounts` (mock) | user_id, acct_no, balance, lien_total |
| `ledger_entries` | account_id, delta, kind, ref_id, created_at (double-entry, append-only) |
| `devices` | id, user_id, public_key, revoked |
| `pockets` | cert_id, user_id, device_id, limit, spent, expires_at, status |
| `vouchers` | id, cert_id, ctr, payer_id, merchant_id, amount, nonce, state, reject_reason, payload, submitted_by, timestamps. **UNIQUE(cert_id, ctr)** |
| `circles`, `circle_members` | pledge_amount, role, joined_at |
| `loans`, `loan_approvals`, `ious` | amount, due_at, status |
| `proof_events` | user_id, type, amount, meta, created_at |

---

## 8. Build schedule (realistic for 17–20 Oct)

| When | Dev A (Wali): client/offline | Dev B (Timothy): data/server | Helen + Joan: business/pitch |
|---|---|---|---|
| **Fri 17 (tonight)** | Scaffold Next.js PWA, deploy to Vercel (HTTPS is needed for the camera), app shell offline | Supabase project, migrations, MockBank ledger, seed users/vendor | Lock names; source every statistic (see §10); write the interview script |
| **Sat 18** | Keys, cert storage, Request/Voucher QR, scanner, offline verify, IndexedDB queue, connectivity pill | `pocket/issue`, `vouchers/submit`, `settle_voucher()`, attack-rejection paths | **Interview 10–15 vendors and students on campus** (quotes + "lost a sale to network?" count); deck draft |
| **Sat night checkpoint** | **Full offline loop on 2 real phones in airplane mode.** If this fails, cut everything else. | | |
| **Sun 19** | Merchant mode polish, Proof screen, Circle UI, rescue flow | Risk Console + Realtime, Circles/loans API, score function | Final deck, demo script rehearsal, record the backup video in the evening |
| **Mon 20** | Bug bash, freeze by noon | Seed clean demo data | Submit; record the final video |

**Stretch, only after the Saturday checkpoint passes:** a nicer onboarding, and a Trust Score animation.

---

## 9. Demo script (≈4 min)

1. **Control (30 s):** an online ₦3,500 payment to "Mama Tee's Kitchen" settles instantly, and the console lights green.
2. **Wow (60 s):** **both phones go to airplane mode in front of the judges.**
   - Vendor charges ₦500 (water) → student scans, PIN, shows voucher → vendor: ✅ *Guaranteed*.
   - Console shows nothing yet, because the phones are honestly offline.
3. **Reconnect (30 s):** the vendor turns data on → the console animates PENDING → VALIDATED → **SETTLED ✓**.
4. **Try to break it (45 s):**
   - A judge, or you, presses *Replay voucher*: rejected, `replay`.
   - Then *Tamper amount*: rejected, `bad_sig`.
   - Then a 4th offline payment: blocked on the phone.
5. **Circle (45 s):** request ₦15,000 for exam fees → 2 friends approve → disbursed → move ₦5,000 into the Pocket. Then show Proof: score 54 → 61, with the reason.
6. **Close (30 s):** the business slide plus the graduation line.

**Demo insurance:**
- Open the PWA once on Wi-Fi before going on stage.
- Pre-seed balances, and carry two charged Android phones plus one spare.
- Max screen brightness.
- Backup video on the laptop.
- A hidden "demo reset" button on the console.

---

## 10. Judge-proofing: claims and answers

**Claims to fix or source before the pitch:**
- "85% of Nigerian tertiary students lack credit history": find a source (CRC/FirstCentral/EFInA) or soften it to "most."
- "40%+ monthly interest from loan apps": cite FCCPC enforcement or press reports, or say "very high."
- Vendor pain: use **your own interview numbers.** Judges trust primary data more than any other kind.

**Likely questions:**

| Question | Answer |
|---|---|
| What if the student has no money? | They can only spend offline what's already locked in the Pocket. |
| Can someone copy the QR? | It's bound to that vendor, that sale, and a 90-s window, with a single-use counter. Watch the replay get rejected. |
| Why not just USSD? | USSD needs a signal too, and it fails in the same congested cells. We work with **zero** signal. USSD for feature phones is on the roadmap. |
| Why a PWA? | Zero install friction, the link spreads on WhatsApp, and it runs on low-end Android. Native comes later for NFC/BLE. |
| What does Ecobank gain? | Student accounts, Pocket float (deposits), vendor acquiring without POS hardware, a lending book that starts fully secured, and alternative-data credit profiles. |
| Regulation? | Runs on Ecobank's licence; tiered KYC (Xpress Tier 1 → BVN/NIN); NDPA 2023 consent for Proof data; lending under Ecobank's existing consumer-lending framework (incl. FCCPC digital-lending rules); pilot via CBN Regulatory Sandbox. *(Pitch team: verify current names and limits.)* |
| Rollout? | Pilot at 1 campus → 50 vendors + 1,000 students → measure lost-sale recovery and repayment rate → expand to markets and motor parks. |

---

## 11. Open decisions (need answers today)

1. Is **20 Oct** the regional-round submission? What exactly is due (video, deck, live link, repo)?
2. Do we **build in the existing `WaliMedugu/blaze-circle` repo** or start a fresh `blaze-grid` repo? What's in it now?
3. Do we have Ecobank developer sandbox access? (Default: MockBank.)
4. What are the official team name and logo usage rules?
5. Do Wali and Timothy agree to drop Python for an all-TypeScript build?
