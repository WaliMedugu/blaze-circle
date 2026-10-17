# Blaze-Grid

Offline-first campus payments + peer credit on Ecobank rails. InnovateX 2026, Track A.
Full plan: [`docs/BLAZE_GRID_BUILD_PLAN.md`](docs/BLAZE_GRID_BUILD_PLAN.md) · Pitch summary: [`docs/ECOBANK_BLAZE_GRID_BLUEPRINT.md`](docs/ECOBANK_BLAZE_GRID_BLUEPRINT.md).

## Run

```bash
npm install
cp .env.example .env.local      # fill Supabase keys
node scripts/gen-bank-key.mjs   # paste output into .env.local
npm run dev
npm test                        # relay protocol + attack tests
```

Offline behaviour (service worker) only runs in a production build: `npm run build && npm start`.
Camera scanning needs HTTPS on phones — test on the Vercel deploy, not `localhost`.

## Try the payment loop (Day 2)

Two phones, or two browser tabs:

1. **Tab A:** pick **$wali**, then **Top up Pocket** (₦2,000). This needs a connection.
2. **Tab B:** go to `/merchant`, pick **Mama Tee's Kitchen**, type an amount, and tap **Charge**.
3. Tick **Simulate no data** on Tab A's home screen. It applies to both tabs, so you don't need airplane mode.
4. **Tab A:** **Scan to Pay**, enter PIN `1234`, and the voucher QR appears.
5. **Tab B:** **Customer is offline → scan their code**. You should see ✓ Received · Guaranteed.
6. Untick **Simulate no data**. Within ~5 s the vendor shows **Settled ✓**.

In dev, a phone camera is optional: each scanner has a "paste code" box, and the QR element carries its payload in `data-payload`.

**Mock bank:** all accounts and balances live in server memory (`lib/bank/mock.ts`). They reset when the server restarts, and they **won't work on Vercel**, where each request can hit a different instance. Swap in Supabase before deploying.

## Database

Push `supabase/migrations/0001_init.sql` with `supabase db push` (after `supabase link`),
or paste it into the Supabase SQL editor.

## Layout

| Path | What |
|---|---|
| `lib/relay/` | Pocket certs, voucher sign/verify, risk rules. Shared by phone and server. |
| `lib/offline/` | Connectivity detection (Day 2: IndexedDB queue + sync) |
| `lib/bank/adapter.ts` | `EcobankAdapter` seam — MockBank now, Ecobank sandbox later |
| `supabase/migrations/` | Schema, `issue_pocket`, `settle_voucher`, RLS |
| `public/sw.js` | App-shell service worker |
