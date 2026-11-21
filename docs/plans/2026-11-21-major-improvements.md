# Major improvements plan (2026-11-21)

Goal: raise every graded area to at least an A. Nothing is pushed; the student reviews the local diff and the report first.
Budget: about $20 of AI work. Pro plan, so it's paced by the usage meter, stopping early if limits get close.

| Area (grade now) | What gets it to A | Step |
|---|---|---|
| Testing (C−) | CI runs every test script and a type check before building; a failing test blocks the release | 1 |
| AI reliability (C+), Speed (C) | Optional **Claude API** provider (student's own key): Claude first, then Gemini/Cerebras as fallbacks; fast model for generation, stronger model for marking; streaming kept | 2 |
| Breadth (A), student ideas | **Ask AI takes photos and voice**: attach photos of a problem or diagram; record a voice question (transcribed, then asked) | 3 |
| IB fit (B) | **IB-style exam questions**: a "Write like IB papers" option that models questions on typical IB phrasing, command terms, mark splits and structures for the course, still marked against sources | 4 |
| Reading & PDFs (C) | **Read this page with AI**: render a PDF page and transcribe it (equations as LaTeX, figures described) to replace bad extracted text; scanned PDFs no longer rejected (pages read on demand) | 5 |
| Search & citations (B−) | **Sentence-level citation highlight**: a citation jumps to the sentence in the passage that best matches the cited claim, not the whole chunk | 5 |
| Code health (C+) | Split `lib/local/store.ts` into modules (jobs, sources, chat, artifacts) with no behaviour change; laptop engine marked legacy in the docs | 6 |
| Design & UI (B−) | Replace the CSS hack that hides the command bar with explicit state; consistent headers and empty/error states across Practice, Listen, Summarise | 6 |

Each step: a builder implements it, runs the tests, and I check the result. Then reviewer rounds on the full diff (high and medium issues fixed).

## What can't reach A from here (needs the student)

- **Real-world proof**: a week of use on the phone. Tests and browser checks only go so far.
- **Marking calibration**: needs real IB markschemes the student legitimately has (no pirated papers). A calibration harness is added so they can drop in their own examples.
- **Claude API**: needs the student's own API key, which is paid. The code ships off until a key is saved.
