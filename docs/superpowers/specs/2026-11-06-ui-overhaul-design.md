# UI overhaul: "Nebula Amber" (design)

Date: 2026-11-06 · Status: approved in chat, awaiting review of this write-up

## Why

The student finds the current look (warm beige paper, Fraunces/Public Sans, pill buttons) dull and dated, and
pill/bubbly shapes "look too much like AI". Structure, navigation and features are fine and must not change.
Success = the app feels dark, sleek and sharp on phone and PC, with nothing broken.

## Decisions (from the student)

| Topic | Decision |
|---|---|
| Overall feel | Dark & sleek, "Nebula" direction (cool navy-black, crisp modern sans) |
| Light mode | Dark by default; a Dark/Light switch in Settings |
| Accent | **Amber** (not violet: violet reads as "AI") |
| Corners | **2px** everywhere; no pills, no bubbly shapes |
| Phone navigation | Keep the left side rail |
| Fonts | Sans everywhere; a serif only for long reading |

Assumed and accepted: every screen is restyled (Library, Read, Ask AI, Summarise, Practice, Listen, Settings,
dialogs, command bar, response sheet, margin threads); app icon and splash change to match; no glows,
gradients or sparkle icons; NotebookLM-avoidance constraints still hold (no three-column layout, no
Google blue/white).

## Visual system

### Colour tokens (same token names as today, new values)

Components already use Tailwind colours mapped to CSS variables (`paper, rail, card, sunken, line, ink,
ink-soft, muted, accent, accent-soft, moss, danger, danger-soft`, highlight vars). Keep the names, change the
values, so components keep working:

| Token | Dark (default) | Light | Role |
|---|---|---|---|
| `--paper` | `#0e1016` | `#f4f5f8` | page background |
| `--rail` | `#0b0d12` | `#eceef3` | side rail |
| `--card` | `#161925` | `#ffffff` | panels, cards, inputs |
| `--sunken` | `#1c2030` | `#e8eaf0` | wells, segmented control track, hover |
| `--line` | `#252a3a` | `#d9dce5` | 1px borders |
| `--ink` | `#e7e9f2` | `#12141c` | primary text |
| `--ink-soft` | `#c9ccd8` | `#2a2e3b` | long-reading text |
| `--muted` | `#8a90a6` | `#626a80` | secondary text, icons |
| `--accent` | `#f2b13c` | `#9a6200` | the one accent: primary button, active rail item, citations, focus |
| `--accent-soft` | `#3a2e15` | `#fbecd0` | tinted accent backgrounds |
| `--on-accent` (new) | `#0e1016` | `#ffffff` | text on accent fills |
| `--moss` | `#4cc38a` | `#1f8a57` | success / correct |
| `--danger` | `#ff6b6b` | `#c52a2a` | errors / wrong |
| `--danger-soft` | `#3a1c20` | `#fbe1e1` | error backgrounds |
| `--hl-anchor` | `#4a3a16` | `#fde9b8` | Read-mode anchor highlight |
| `--hl-anchor-active` | `#6b5216` | `#fbd77a` | active anchor |
| `--hl-focus` | `#7a5a10` | `#f9c95c` | "jump to citation" flash |

Rules: amber is the only accent (one primary/amber-filled button per view); green/red only for right/wrong and
errors; no gradients, glows or coloured shadows. Hard-coded `rgba(40,30,20,…)` shadows are removed.

### Theme switching

- Dark is the default: tokens live on `:root`; light values on `:root[data-theme="light"]`. The OS
  `prefers-color-scheme` no longer decides.
- Settings gets an "Appearance: Dark / Light" control (local engine; the laptop server build is dark only).
  Stored in device settings and mirrored to `localStorage` so a tiny inline script in `layout.tsx` sets
  `data-theme` before first paint (no flash).
- Android: the status/navigation bar icon colour follows the theme (Capacitor `SystemBars.setStyle`).
- `viewport.themeColor` and the PWA manifest colours become the dark paper colour.

### Typography

- **Inter** for all UI (via `next/font/google`), replacing Public Sans and Fraunces.
- Headings (`font-display`, 45 uses) become Inter at weight 600 with tracking −0.02em: a global rule adds
  weight/tracking to `.font-display`, so call sites don't change.
- **Literata** stays as `font-reading` for long reading only: Read-mode source text, summaries, study sheets,
  AI answers (AnswerBody), episode transcripts.
- Small uppercase eyebrow labels stay but use Inter at 11px, tracking 0.12em.

### Shape and depth

- Corners: 2px on every button, card, input, dialog, chip and segmented control. Tailwind's radius scale
  (`--radius-sm … --radius-3xl`) is set to 2px in `@theme`; the 32 `rounded-full` uses are reviewed one by one:
  real circles that aren't controls (status dots, the progress-bar ends) may stay round; every button,
  pill, chip, input and send button becomes 2px.
- Flat: no drop shadows on cards; separation by 1px `--line` borders and `--card` vs `--paper` contrast.
  Dialogs/sheets keep one subtle dark shadow so they read as floating.
- Shared primitives in `globals.css` are rewritten: `.btn-primary` (amber fill, `--on-accent` text, 2px),
  `.btn-ghost` (1px border, muted text, hover ink), `.field` (card bg, 1px line, amber focus border),
  `.cite-marker` (2px, accent-soft bg, amber text; hover amber fill).
- Focus: visible 2px amber outline on keyboard focus for buttons, inputs and rail items.
- Motion: keep short fades/rises (≤200ms, ease-out); no bounce.

### App icon and splash

Regenerate `frontend/assets/*` and `public/icons/*` (same script approach as before): navy-black square
`#0e1016` with an amber lowercase "m" in a geometric sans and a short amber underline; splash = icon centred
on `#0e1016` with "Marginalia" in Inter (light splash on `#f4f5f8`). Update `capacitor.config.ts`
(`SplashScreen.backgroundColor`) and the workflow's `@capacitor/assets` colour flags.

## Scope of change

- `app/globals.css`: tokens, theme selector, radius scale, primitives, `.font-display` weight.
- `app/layout.tsx`: fonts (Inter + Literata), theme bootstrap script, theme colour.
- Settings: Appearance control; `lib/local/settings.ts` gains `theme: "dark" | "light"`; a small
  `lib/theme.ts` applies it (DOM attribute, localStorage, Android bars).
- Component sweep (all of `components/`): replace pill/large-radius classes where the scale change isn't enough,
  remove hard-coded shadows, make primary actions amber (`bg-accent text-on-accent`) instead of ink-filled,
  keep one primary per view, check contrast of every `text-paper` on fills.
- Icons/splash assets, manifest colours, Capacitor config, workflow flags.
- Docs: CLAUDE.md design-identity line, INSTALL.md mention of the Appearance switch.

Out of scope: layout or navigation changes, new features, the backend.

## Testing

- `tsc`, `npm run test:sync`, `npm run test:formats`, static build.
- Screenshots of every mode (Library, Read with highlights and margin thread, Ask AI, Summarise, Practice:
  cards/quiz/exam, Listen, Settings, a confirm dialog) at 375px and desktop width, in dark and light.
- Contrast spot-checks: body text, muted text, amber on paper, text on amber (aim for WCAG AA).
- No horizontal overflow at 375px (scrollWidth check), as done for the Library header fix.
