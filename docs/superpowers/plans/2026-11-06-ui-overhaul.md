# UI Overhaul ("Nebula Amber") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle every screen of the Marginalia frontend to dark navy + amber, 4px corners, Inter + Literata, with a Dark/Light switch, without changing layout, navigation or features.

**Architecture:** Components already colour themselves through Tailwind tokens backed by CSS variables (`paper, rail, card, sunken, line, ink, ink-soft, muted, accent, accent-soft, moss, danger, danger-soft`). We give those variables new values (dark on `:root`, light on `:root[data-theme="light"]`), set Tailwind's radius scale to 4px, rewrite the shared CSS primitives, swap fonts, add a tiny theme module, then sweep components for the few things tokens can't fix (pills, ink-filled primary buttons, hard-coded shadows).

**Tech Stack:** Next.js 16 (static export), Tailwind v4 (`@theme inline` in `app/globals.css`), `next/font/google`, Dexie settings, Capacitor 8 (`SystemBars`), Python/Pillow for icon generation.

**Spec:** `docs/superpowers/specs/2026-11-06-ui-overhaul-design.md`

## Global Constraints

- Colours: exactly the token table in the spec (dark default, light under `data-theme="light"`); amber `#f2b13c` dark / `#9a6200` light; `--on-accent` `#0e1016` dark / `#ffffff` light.
- Corners: 4px on buttons, cards, inputs, dialogs, chips, segmented controls; no pills. Only non-interactive dots may stay round.
- One amber-filled (primary) control per view; green/red only for right/wrong and errors.
- No gradients, glows, coloured or warm `rgba(40,30,20,…)` shadows. Dialogs/sheets may keep one neutral dark shadow.
- Fonts: Inter for UI; Literata (`font-reading`) only for long reading; Fraunces and Public Sans removed.
- Layout, navigation (left rail on all sizes), features and copy stay as they are.
- Dark is the default and the OS colour-scheme preference no longer switches it; the laptop server build is dark-only.
- Works at 375px wide with no horizontal overflow; Android safe areas still respected.

## Review Focus

1. **Theme flash on load:** a light-theme user must not see a dark flash (or vice versa) before React mounts → bootstrap script test in Task 2.
2. **Text on amber fills:** every element that used `text-paper` on a coloured fill must stay readable in both themes (dark text on amber in dark, white on deep amber in light) → grep check + screenshots in Task 3.
3. **Native `<select>` dropdowns** (subject switcher, IB course, reminder hour) must show readable options on dark → `select option` rule in Task 1, checked in Task 3 screenshots.
4. **Read-mode highlights and text selection** (`.hl-anchor`, `.hl-focus` flash, `::selection`) must stay visible but not glaring on dark → Task 1 values, Task 3 Read screenshot.
5. **Android status/navigation bar icons** must be visible in both themes → `applyTheme` calls `SystemBars.setStyle` (Task 2); verified on the phone after release.

---

### Task 1: Tokens, radius scale and shared primitives

**Files:**
- Modify: `frontend/app/globals.css` (token block lines ~4-62, primitives ~85-210)

**Interfaces:**
- Produces: CSS variables with the spec's values; new token `--on-accent` exposed to Tailwind as colour `on-accent` (`--color-on-accent`); radius scale `--radius-xs … --radius-3xl: 4px` inside `@theme`; primitives `.btn-primary`, `.btn-ghost`, `.field`, `.cite-marker`, `.caret`, `.hl-*`; `.font-display { font-weight: 600; letter-spacing: -0.02em }`.

- [ ] **Step 1:** Replace the light `:root` block and the `@media (prefers-color-scheme: dark)` block with: dark values on `:root`, light values on `:root[data-theme="light"]` (spec table, including `--on-accent`). Add `color-scheme: dark` / `light` respectively so scrollbars and form controls match.
- [ ] **Step 2:** In `@theme inline` add `--color-on-accent: var(--on-accent);`, and `--radius-xs/-sm/-md/-lg/-xl/-2xl/-3xl: 4px;`. Keep `--radius` default (`rounded`) at 4px too (`--radius: 4px` is not a Tailwind v4 key; set `--radius-DEFAULT` only if `rounded` doesn't pick up 4px; verify in Step 5).
- [ ] **Step 3:** Rewrite primitives: `.btn-primary` = `background: var(--accent); color: var(--on-accent); border-radius: 4px`; `.btn-ghost` = `border-radius: 4px` (rest unchanged); `.field` = `border-radius: 4px; background: var(--card)`; `.cite-marker` = `border-radius: 4px`, hover `color: var(--on-accent)`; `.hl-*` radius 2px unchanged; `select option { background: var(--card); color: var(--ink) }` stays; add `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }` for `button, a, [role=radio], select, input, textarea`; add the `.font-display` weight/tracking rule.
- [ ] **Step 4:** Build: `cd frontend && node scripts/build-static.mjs` → ends with `PWA: … files precached`.
- [ ] **Step 5:** Serve `out/` (launch config `static`) and in the browser run `getComputedStyle(document.querySelector('.btn-ghost')).borderRadius` → `"4px"`, `getComputedStyle(document.body).backgroundColor` → `rgb(14, 16, 22)`.
- [ ] **Step 6:** Commit `style: Nebula Amber tokens, 4px radius scale, primitives`.

### Task 2: Fonts and the theme switch

**Files:**
- Create: `frontend/lib/theme.ts`, `frontend/scripts/theme-test.mts`
- Modify: `frontend/app/layout.tsx`, `frontend/lib/local/settings.ts`, `frontend/components/SettingsSheet.tsx`, `frontend/components/App.tsx`, `frontend/package.json` (script `test:theme`), `frontend/scripts/build-static.mjs` (manifest colours)

**Interfaces:**
- Produces (`lib/theme.ts`): `type Theme = "dark" | "light"`; `const THEME_KEY = "marginalia.theme"`; `normalizeTheme(v: unknown): Theme` (anything but `"light"` → `"dark"`); `THEME_BOOTSTRAP: string` (an inline script that reads `localStorage[THEME_KEY]`, and sets `document.documentElement.dataset.theme` only when it is `"light"`, wrapped in try/catch); `applyTheme(t: Theme): void` (sets/removes `data-theme`, writes `localStorage`, and on native calls `SystemBars.setStyle({ style: t === "dark" ? SystemBarsStyle.Dark : SystemBarsStyle.Light })`, errors ignored).
- Produces (`settings.ts`): `Settings.theme: Theme`, default `"dark"`.

- [ ] **Step 1: Write the failing test** `scripts/theme-test.mts`: (a) `normalizeTheme("light") === "light"`, `normalizeTheme("x") === "dark"`, `normalizeTheme(undefined) === "dark"`; (b) run `THEME_BOOTSTRAP` with `new Function` against a fake `{ localStorage: { getItem: () => "light" }, document: { documentElement: { dataset: {} } } }` → `dataset.theme === "light"`; with `getItem: () => null` → `dataset.theme === undefined`; with `getItem` throwing → no exception.
- [ ] **Step 2:** `npx tsx scripts/theme-test.mts` → fails (module missing).
- [ ] **Step 3:** Implement `lib/theme.ts` (import `SystemBars`/`SystemBarsStyle` from `@capacitor/core` lazily inside `applyTheme`, guarded by `Capacitor.isNativePlatform()`). Add `"test:theme": "tsx scripts/theme-test.mts"`.
- [ ] **Step 4:** `npm run test:theme` → `ALL THEME CHECKS PASSED`.
- [ ] **Step 5:** `layout.tsx`: replace `Fraunces`/`Public_Sans` with `Inter({ variable: "--font-ui", subsets: ["latin"] })`; keep `Literata` as `--font-reading-face`; point `--font-display` (in `@theme`) at `var(--font-ui)`; inject `<script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />` first in `<head>`; `viewport.themeColor` → `#0e1016`; add `suppressHydrationWarning` on `<html>` (the script adds an attribute before hydration).
- [ ] **Step 6:** Settings: add `theme` to `Settings`/`DEFAULTS`; in `SettingsSheet` add an "Appearance" section (non-first-run) with `Segmented` options `[{value:"dark",label:"Dark"},{value:"light",label:"Light"}]` calling `update({ theme })` then `applyTheme(theme)`. In `App.tsx` local-engine effect, call `applyTheme(s.theme)` after `getSettings()` (keeps localStorage in sync with the synced setting).
- [ ] **Step 7:** `build-static.mjs`: manifest `background_color: "#0e1016"`, `theme_color: "#0e1016"`.
- [ ] **Step 8:** `npx tsc --noEmit -p .` clean; build; in the browser switch to Light in Settings → `document.documentElement.dataset.theme === "light"`, reload → still light with no dark frame (screenshot right after reload); switch back → attribute removed.
- [ ] **Step 9:** Commit `feat: Inter/Literata fonts and Dark/Light appearance switch`.

### Task 3: Component sweep

**Files (call sites found by grep, line numbers as of commit 78a64d7):**
- `rounded-full` → 4px (`rounded`) unless a non-interactive dot: `AskMode.tsx:260,298`, `CommandBar.tsx:68,78,82,107,132,135`, `LibraryMode.tsx:114,267,432,532,590`, `ListenMode.tsx:139,153,396`, `PracticeMode.tsx:253,583`, `Rail.tsx:35,78`, `SheetsPanel.tsx:170`, `SummariseMode.tsx:212,244`, `study/shared.tsx:177,178,196,249,268,276,302,303`, `lib/confirm.tsx:67`. Keep round: the status dots (`h-1.5 w-1.5` / `h-2 w-2` dots, e.g. `AskMode.tsx:260`, `Rail.tsx:78`) and progress-bar tracks.
- Ink-filled controls → amber primary (`bg-accent text-on-accent`) when they are the view's main action, otherwise ghost/segmented style: `CommandBar.tsx:108`, `LibraryMode.tsx:268` (active add-source tab → `bg-accent text-on-accent`), `ListenMode.tsx:153`, `MarginThread.tsx:117`, `SummariseMode.tsx:212`, `Rail.tsx:35` (logo mark: navy square, amber "m": `bg-card text-accent ring-1 ring-line`), `SettingsSheet.tsx:105` overlay (`bg-ink/30` → `bg-black/60`).
- Remaining `text-paper` on fills → `text-on-accent`: `AskMode.tsx:298`, `LibraryMode.tsx:418`, `SummariseMode.tsx:215`.
- Hard-coded shadows removed or replaced by `shadow-[0_12px_40px_-12px_rgba(0,0,0,.6)]` for floating sheets only: `AskMode.tsx:274` (remove), `CommandBar.tsx:75` (floating: replace), `LibraryMode.tsx:259` (remove), `ResponseSheet.tsx:40` (floating: replace). `shadow-sm` on active segmented items stays (neutral).
- Eyebrow labels (`text-xs uppercase tracking-[0.18em]` / `tracking-[0.16em]`) → `text-[11px] uppercase tracking-[0.12em]`.
- Rail active item: `bg-card shadow-sm ring-1 ring-line` → `bg-card text-accent ring-1 ring-line`; active indicator bar stays `bg-accent`.

- [ ] **Step 1:** Apply the replacements above.
- [ ] **Step 2:** Grep gates (each must print nothing): `grep -rn "rgba(40,30,20" components lib`; `grep -rn "bg-ink[^/]" components | grep -v "bg-ink/"`; `grep -rn "text-paper" components`; `grep -rn "rounded-full" components lib | grep -v -E "h-1\.5|h-2 w-2|h-1 |progress"`.
- [ ] **Step 3:** `npx tsc --noEmit -p .`; `npm run test:sync`; `npm run test:formats -- <fixtures>`; build.
- [ ] **Step 4:** Browser at 375×812 and 1280×800, dark then light: screenshot Library (with a source and the IB picker open), Read (with an anchor highlight and margin thread), Ask AI (a conversation with an error turn), Summarise, Practice (deck review, quiz, exam question), Listen, Settings, a confirm dialog. At 375px also run `document.getElementById('mode-scroll').scrollWidth === clientWidth` per mode → all true.
- [ ] **Step 5:** Fix anything the screenshots show (contrast, leftover pills, clipped text), re-run Step 4 for affected screens.
- [ ] **Step 6:** Commit `style: sweep components for Nebula Amber`.

### Task 4: App icon, splash and native colours

**Files:**
- Create: `frontend/scripts/make-icons.py` (Pillow; writes `public/icons/icon-{48..512}.png`, `maskable-{192,512}.png`, `apple-touch-icon.png`, and `assets/icon-only.png`, `icon-foreground.png`, `icon-background.png`, `splash.png`, `splash-dark.png`)
- Modify: `frontend/capacitor.config.ts:24` (`backgroundColor: "#0e1016"`), `.github/workflows/android.yml:51-52` (`--iconBackgroundColor '#0e1016' --iconBackgroundColorDark '#0e1016' --splashBackgroundColor '#0e1016' --splashBackgroundColorDark '#0e1016'`)

- [ ] **Step 1:** Write `make-icons.py <frontend-dir>`: background `#0e1016`, lowercase "m" in Segoe UI Semibold (`C:/Windows/Fonts/seguisb.ttf`, fallback `arial.ttf`) coloured `#f2b13c`, a short amber underline; maskable variants at 0.46 scale; splash 2732² `#0e1016` with icon centred and "Marginalia" in Segoe UI `#e7e9f2` (`splash-dark.png` identical).
- [ ] **Step 2:** Run it (`cd backend && uv run --no-project --with pillow python ../frontend/scripts/make-icons.py ../frontend`), open `public/icons/icon-192.png` and `assets/splash.png` to check by eye.
- [ ] **Step 3:** Update Capacitor config and workflow flags; `npx cap sync android` succeeds.
- [ ] **Step 4:** Commit `style: navy and amber app icon and splash`.

### Task 5: Docs, release and verification

**Files:**
- Modify: `CLAUDE.md` (design-constraints identity line: "dark navy `#0e1016`, amber accent `#f2b13c`, 4px corners, Inter UI + Literata for long reading, Dark/Light switch in Settings (`lib/theme.ts`)"), `INSTALL.md` (one line: Settings → Appearance)

- [ ] **Step 1:** Update docs.
- [ ] **Step 2:** Full check: `npx tsc --noEmit -p .`, `npm run test:theme`, `npm run test:sync`, `npm run test:formats -- <fixtures>`, `node scripts/build-static.mjs`.
- [ ] **Step 3:** Commit, push to `main`; wait for both GitHub Actions runs to succeed; confirm the live site's CSS contains `#0e1016` and the latest release has a new version tag.
