# DealTracker — Commission Tracker (PWA)

A local-first Progressive Web App. It works fully offline the moment it's
deployed — no backend required to start using it on your phone.

## What's in this folder

| File | Purpose |
|---|---|
| `index.html` | App shell — all three screens (Pipeline, Calendar, Reports) plus the Add Deal and Deal Detail modals |
| `styles.css` | Visual design (dark "stamped ledger" theme, mobile-first) |
| `app.js` | Core commission logic (ported from `commission-tracker-core.ts`) + UI wiring + localStorage persistence |
| `manifest.json` | Makes it installable ("Add to Home Screen") |
| `sw.js` | Service worker — caches the app shell so it opens with no signal |
| `icons/` | App icons (placeholders — swap these for your own branding) |
| `supabase-schema.sql` | Optional: database schema for when you want cross-device sync |

## How data storage works right now

All deals live in the phone's **localStorage** — nothing leaves the device.
This means:
- ✅ Works completely offline, zero setup, zero cost
- ✅ Fast — no network round-trip for any action
- ❌ Data is tied to one device/browser. Clearing browser data or switching phones loses it.
- ❌ No backup unless the agent exports CSV manually

This is a deliberate MVP tradeoff: **get the agent to core value in 30
seconds with zero backend to configure.** Add Supabase (below) when you're
ready for sync/backup — the storage layer in `app.js` (`loadDeals`/`saveDeals`)
is the only place you'll need to touch.

## Deploying to Vercel (free)

1. Push this `pwa/` folder to a GitHub repo (or use the Vercel CLI directly).
2. Go to [vercel.com](https://vercel.com), sign in with GitHub, click **Add New → Project**, select the repo.
3. Framework preset: choose **"Other"** — this is a static site, no build step needed.
4. Root directory: point it at the `pwa/` folder if your repo has other stuff in it.
5. Deploy. Vercel gives you a free `*.vercel.app` HTTPS URL — required for PWA installability (service workers need HTTPS).
6. On the agent's phone: open the URL in Chrome (Android) or Safari (iOS) → **Add to Home Screen**. It now behaves like a native app icon, opens full-screen, works offline.

**Alternative free hosts** (all equally fine for a static PWA like this):
- **Netlify** — same drag-and-drop or GitHub deploy flow as Vercel.
- **Cloudflare Pages** — fastest global edge network, generous free tier.
- **GitHub Pages** — simplest if you don't need custom headers, works fine here.

Vercel is the easiest starting point if you're not choosing between them for
a specific reason — the free tier comfortably covers a single-agent or
small-team tool like this.

## Upgrading to Supabase (free tier) for cross-device sync

Supabase is the natural fit here because the schema we designed earlier is
already Postgres — Supabase **is** hosted Postgres, plus auth and a REST API
generated automatically from your tables, all on a free tier (500MB database,
50k monthly active users — far beyond what a single agent or small agency needs).

**Setup:**
1. Create a project at [supabase.com](https://supabase.com) (free tier, no card required).
2. Open the **SQL Editor** and run `supabase-schema.sql` from this folder — it creates the tables and the Row Level Security policies that keep one agent's deals invisible to another.
3. In **Authentication → Providers**, enable Email (magic link is simplest — no passwords to manage).
4. Grab your **Project URL** and **anon public key** from Settings → API.
5. In `index.html`, add the Supabase client before `app.js`:
   ```html
   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
   ```
6. In `app.js`, replace the bodies of `loadDeals()` and `saveDeals()` with calls to `supabase.from('deals').select()` / `.upsert()`. Everything else in the file — the commission math, the stage logic, the rendering — stays untouched, because it was written to not know or care where the data comes from.

**Why Supabase over the alternatives:**
- **Firebase** — also free-tier friendly, but it's NoSQL (Firestore), which means re-modeling the relational schema we designed (deals → co_broke_partners → stage_history) instead of reusing it directly.
- **PlanetScale / Neon** — good free Postgres hosts, but you'd still need to build auth and a REST/RPC layer yourself. Supabase bundles both.

## Common next steps

- Swap the placeholder icons in `icons/` for real branding.
- Add the `subscriptions` / `billing_events` tables from the architecture doc once you wire up Stripe for paid plans.
- Add a simple email/magic-link login screen once Supabase is wired in — right now the app assumes single-user/single-device.
