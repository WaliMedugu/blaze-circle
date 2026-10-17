# ECOBANK BLAZE-GRID
## Blueprint v2 (aligned with the build)

> *"Blaze-Grid does not try to make the internet better. It makes payments stop depending on it."*

- **Competition:** InnovateX 2026 · **Track:** A, Inclusive Finance
- **Team:** Tensor Labs (4 members), *pending confirmation*
- **Build plan:** [BLAZE_GRID_BUILD_PLAN.md](BLAZE_GRID_BUILD_PLAN.md) · **Code:** this repo

---

## 1. Problem

Campus vendors and students lose sales whenever data drops, which happens all the time in crowded cells. At the same time, students have no credit history, so in an emergency they turn to predatory loan apps.

## 2. Solution

Blaze-Grid is an **offline-first payment and peer-credit layer on Ecobank rails**:

- A student pays a vendor with **zero data on either phone**.
- The vendor is **guaranteed** payment, because the money was locked by Ecobank in advance.
- Every payment builds a **verified trust history** that unlocks Circle-backed credit.

## 3. Architecture

```
 Student PWA ──(online: HTTPS)──────────────┐
      │                                     ▼
      └─(offline: 2-way signed QR)─▶ Vendor PWA ──(on reconnect)──▶ Blaze-Grid API ──▶ EcobankAdapter ──▶ Core ledger
                                                                     (Next.js, TS)      (mock → sandbox)
```

| Layer | What it does |
|---|---|
| **Blaze Relay** | Bank-signed Pocket Certificates, ECDSA-signed vouchers, offline verification, sync, atomic settlement |
| **Blaze Flow** | Student pay and receive; vendor Merchant mode |
| **Blaze Circles** | Pledges, Circle-backed credit, pay-for-a-friend rescue |
| **Blaze Proof** | Activity timeline and an explainable Trust Score (0–100), shared only with consent |

Connectivity paths:
- **Online:** standard API call.
- **Offline:** two-way QR between the phones.

## 4. Features that make judges stop

- **Airplane-mode checkout:** both phones are offline; the vendor sees "✅ Received · Guaranteed"; the payment settles when either phone reconnects.
- **Break-it-live Risk Console:** a replayed, tampered, expired, or forged payment, or a 4th offline payment, is rejected on screen with its reason.
- **Circle credit:** a ₦15,000 exam-fee loan, approved by 2 friends and backed by their pledges, which the student can then spend offline.
- **Dead-phone rescue:** the vendor enters the student's `$BlazeTag`, and a Circle friend approves and pays. This needs the vendor's phone to have data.

## 5. Bounded risk

| Bound | Value | Protects |
|---|---|---|
| Blaze Pocket | ≤ ₦5,000, **pre-funded and liened** | The bank never lends offline |
| Offline vouchers per sync | 3 | Limits how stale the phone's state can get |
| Request→scan window | 90 s, vendor clock | Replay and screenshots |
| Pocket certificate life | 72 h | Forces a regular sync; unused money returns automatically |

States: `PENDING_SETTLEMENT → RECEIVED_VALIDATED → SETTLED_CONFIRMED` (or `REJECTED`).

If a cloned phone spends the same pocket twice, the vendor is still paid. The overspend is recovered from the KYC'd account and offline mode is revoked. This is **bounded risk, not zero risk.**

## 6. Demo (4 min)

1. Online payment of ₦3,500.
2. Both phones in airplane mode → ₦500 offline payment, "Guaranteed."
3. Reconnect → SETTLED ✓.
4. Attack buttons, each rejected live.
5. Circle loan → Trust Score goes up.

## 7. Removed from v1, and why

| v1 claim | Why it's gone |
|---|---|
| Background USSD "signaling plane" | Web apps (and most native apps) can't send USSD silently. USSD also needs a signal, so it fails in the same congested cells. |
| HMAC-SHA256 offline tokens | Checking an HMAC needs the shared secret, which would let the vendor forge payments. Replaced by public-key signatures (ECDSA). |
| "Whistle & Pay" ultrasound | Browser audio sends about 8–30 bytes/s, and a signed voucher is ~350 bytes, so it's too slow and unreliable in noisy rooms. |
| Blaze Route peer delivery | A separate logistics business with liability and matching problems. It's moved to the roadmap. |
| Python `blaze_relay_engine.py` | A second runtime and deploy for no demo gain. The same logic runs in TypeScript on both phone and server. |
| "Fused legacy DNA" of past winners | It invites a "derivative" objection. The pitch stands on its own design. |
| "Eliminates replay / ledger drift" | Overclaims. Replaced by bounded-risk language. |

## 8. Roadmap (slides only)

- SMS fallback via Ecobank short code.
- NFC/Bluetooth tap-to-pay in a native wrapper.
- USSD for feature phones (*326#).
- Blaze Route deliveries.
- Expansion to markets and motor parks.
