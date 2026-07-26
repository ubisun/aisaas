# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Project

DocAI — a daily market report SaaS. After the US market closes, it collects the closing quotes for the broad indices and the sector ETFs, summarises the session, and projects which KRX sectors are likely to be affected on the next Korean trading day. The report has to be ready before KRX opens at 09:00 KST.

The package name in `package.json` is `docai` and the repo directory is `aisaas`; both predate the current scope and are kept as-is.

The hard rules (Clerk integration, secret handling, queueing, webhook verification) live in `AGENTS.md`, imported above, so they are always loaded alongside this file.

## Commands

```bash
npm run dev      # dev server (Turbopack, port 3000)
npm run build    # production build
npm start        # serve the production build
npm run lint     # eslint (flat config)
```

There is no test runner yet. `npx tsc --noEmit` is the only type check (`noEmit` is already set in tsconfig).

## Current state vs. target stack

**Target stack** (pinned — update this file when it changes)

- Next.js 16.2.x / App Router / TypeScript / Tailwind CSS v4
- Auth: Clerk
- DB/Storage/Vector: Supabase (Postgres + pgvector)
- Queue: Upstash QStash
- Deploy: Vercel

**What is actually installed** is `next`, `react`, and `react-dom` — nothing else. The Clerk, Supabase, and QStash SDKs are absent, and the code is still the bootstrap: `app/layout.tsx` and `app/page.tsx`. Check `package.json` before importing a library.

Environment variables are in the same position: only `NEXT_PUBLIC_APP_URL` is active. The rest sit commented out in `.env.example`, and there are no QStash variables there yet.

`.gitignore` ignores `.env*` wholesale, but **`.env.example` was force-added and is tracked** — it is the one env file that reaches the remote, so it must never hold a real value. `.env.local` stays local. Adding a variable means editing both.

## Next.js 16 specifics

Per `AGENTS.md`, read `node_modules/next/dist/docs/` before writing code. Load-bearing deltas from Next 14/15 habits:

- **Request APIs are async** — `params`, `searchParams`, `cookies()`, `headers()`, and `draftMode()` must be awaited. Same for `icon`/`opengraph-image` params and `sitemap`'s `id`.
- **`middleware.ts` is now `proxy.ts`** — Next 16 renamed it; `middleware.ts` is deprecated and must never be created. The file goes at the repo root (`proxy.ts`, alongside `app/`) because this project has no `src/` directory, and it exports `proxy`. Same functionality, new name.
- **Turbopack is the default** for both dev and build.
- **`next lint` was removed** — hence `"lint": "eslint"` and the flat config in `eslint.config.mjs`.
- **Caching**: `use cache` plus `cacheComponents: true` in `next.config.ts` is the current model; `experimental.dynamicIO` and `experimental.useCache` are gone. Cache Components are not enabled here, so `node_modules/next/dist/docs/01-app/02-guides/caching-without-cache-components.md` describes current behavior.
- `images.domains` and `next/legacy/image` are deprecated, and several `next/image` defaults changed.

Full list: `node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md`

## Conventions

- Tailwind CSS v4 via `@tailwindcss/postcss` — the theme lives in the `@theme inline` block in `app/globals.css`; there is no `tailwind.config.js`.
- Path alias `@/*` maps to the repo root (not `src/` — there is no `src/` directory).
- Dark mode has two independent mechanisms: `prefers-color-scheme` in `globals.css` swaps the `--background`/`--foreground` variables, while components use `dark:` variants directly. There is no theme provider or class-based toggle.
- Geist Sans/Mono load in `app/layout.tsx` and are exposed as `--font-sans`/`--font-mono`, but `globals.css` sets `body { font-family: Arial… }` — elements need an explicit `font-sans` class to get Geist.

## Workflow

- New features go on a branch. Never commit directly to main.
- Schema changes are recorded as Supabase migration files.
- Everything in the repository — docs, code, comments, commit messages, PR descriptions — is written in English. Conversation with the user is in Korean unless they ask for English.
