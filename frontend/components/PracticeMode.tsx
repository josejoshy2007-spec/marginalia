"use client";

import { useCallback, useEffect, useState } from "react";
import { tap } from "@/lib/native";
import { api, type ArtifactDetail, type ArtifactSummary, type CardItem, type Grade } from "@/lib/api";
import {
  CiteMarks,
  ErrorNote,
  ModeHeader,
  NoSources,
  Segmented,
  scopeLabel,
  timeUntil,
  useArtifacts,
  Working,
  type StudyProps,
  isReady,
  JobStatus,
} from "./study/shared";
import { TrashIcon } from "./icons";
import { ExamRunner, Exams } from "./ExamPractice";
import QuizRunner, { DIFFICULTY_LABEL, QTYPES, similarRequest, typeLabel, type QType } from "./QuizRunner";
import { MathText } from "./AnswerBody";
import { askConfirm } from "@/lib/confirm";

type Tab = "cards" | "quiz" | "exam";
type Open = { kind: "review" | "browse" | "quiz" | "exam"; id: number } | null;

export default function PracticeMode(p: StudyProps) {
  const [tab, setTab] = useState<Tab>("cards");
  const [open, setOpen] = useState<Open>(null);

  if (open?.kind === "review") return <ReviewSession {...p} deckId={open.id} onExit={() => setOpen(null)} />;
  if (open?.kind === "browse") return <BrowseDeck {...p} deckId={open.id} onExit={() => setOpen(null)} />;
  if (open?.kind === "quiz") return <QuizRunner {...p} quizId={open.id} onExit={() => setOpen(null)} onOpen={(id) => setOpen({ kind: "quiz", id })} />;
  if (open?.kind === "exam") return <ExamRunner {...p} examId={open.id} onExit={() => setOpen(null)} />;

  return (
    <div className="mx-auto max-w-5xl px-6 pt-10 sm:px-10">
      <ModeHeader eyebrow="Practice" title="Pull it out of memory">
        <Segmented<Tab>
          label="Practice type"
          value={tab}
          onChange={setTab}
          options={[
            { value: "cards", label: "Recall cards" },
            { value: "quiz", label: "Quizzes" },
            { value: "exam", label: "Exam questions" },
          ]}
        />
      </ModeHeader>
      {p.totalSources === 0 ? (
        <NoSources onGoLibrary={p.onGoLibrary} />
      ) : tab === "cards" ? (
        <Decks {...p} onOpen={(kind, id) => setOpen({ kind, id })} />
      ) : tab === "exam" ? (
        <Exams {...p} onOpen={(id) => setOpen({ kind: "exam", id })} />
      ) : (
        <Quizzes {...p} onOpen={(id) => setOpen({ kind: "quiz", id })} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- decks

function Decks(p: StudyProps & { onOpen: (kind: "review" | "browse", id: number) => void }) {
  const { items, busy, notice, error, setError, generate, remove, refresh, retry, retryLast } = useArtifacts(p.subjectId, "deck");
  const [focus, setFocus] = useState("");
  const [count, setCount] = useState<"10" | "15" | "25">("15");

  return (
    <>
      <form
        className="mt-8 rounded-2xl border border-line bg-card p-5"
        onSubmit={async (e) => {
          e.preventDefault();
          const made = await generate(
            { source_ids: p.checkedIds, focus: focus || null, count: Number(count) },
            "Recall cards:",
          );
          if (made) setFocus("");
        }}
      >
        <p className="font-display text-xl">New card deck</p>
        <p className="mt-1 text-sm text-muted">
          From {scopeLabel(p.checkedIds.length, p.totalSources)}. Cards come back on a spaced schedule: the ones
          you struggle with return sooner.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <input
            value={focus}
            onChange={(e) => setFocus(e.target.value)}
            placeholder="Focus on… (optional, e.g. the Calvin cycle)"
            className="field min-w-[220px] flex-1"
          />
          <Segmented
            label="Number of cards"
            value={count}
            onChange={setCount}
            options={[
              { value: "10", label: "10" },
              { value: "15", label: "15" },
              { value: "25", label: "25" },
            ]}
          />
          <button className="btn-primary" disabled={!!busy || !p.checkedIds.length}>
            Make deck
          </button>
        </div>
        <Working label={busy} notice={notice} />
        {error && <ErrorNote text={error} onClose={() => setError(null)} onRetry={retryLast} />}
      </form>

      <section className="mt-8">
        {items === null ? (
          <p className="text-muted">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-muted">No decks yet.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {items.map((d) => (
              <DeckCard
                key={d.id}
                deck={d}
                onReview={() => p.onOpen("review", d.id)}
                onBrowse={() => p.onOpen("browse", d.id)}
                onDelete={() => askConfirm(`Delete “${d.title}”?`).then((ok) => { if (ok) void remove(d.id); })}
                onRetry={retry}
                onReset={async () => {
                  if (!(await askConfirm("Restart this deck?", { detail: "Every card becomes new and due again.", confirmLabel: "Restart", danger: false }))) return;
                  await api.resetDeck(d.id);
                  refresh();
                }}
              />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function DeckCard({
  deck,
  onRetry,
  onReview,
  onBrowse,
  onDelete,
  onReset,
}: {
  deck: ArtifactSummary;
  onRetry: (id: number) => void;
  onReview: () => void;
  onBrowse: () => void;
  onDelete: () => void;
  onReset: () => void;
}) {
  const due = deck.due_count ?? 0;
  return (
    <li className="group flex flex-col rounded-2xl border border-line bg-card p-4">
      <div className="flex items-start gap-2">
        <p className="flex-1 font-display text-lg leading-snug">{deck.title}</p>
        <button type="button" title="Delete deck" onClick={onDelete} className="text-muted opacity-0 hover:text-danger group-hover:opacity-100">
          <TrashIcon width={16} height={16} />
        </button>
      </div>
      {!isReady(deck) ? (
        <JobStatus a={deck} onRetry={onRetry} />
      ) : (
      <>
      <p className="mt-1 text-xs text-muted">
        {deck.card_count} cards{deck.params.focus ? ` · ${deck.params.focus}` : ""}
      </p>
      <div className="mt-4 flex items-center gap-2">
        <button type="button" onClick={onReview} disabled={!due} className="btn-primary">
          {due ? `Review ${due} due` : "All caught up"}
        </button>
        <button type="button" onClick={onBrowse} className="btn-ghost">
          Browse
        </button>
        <button type="button" onClick={onReset} className="ml-auto text-xs text-muted underline-offset-2 hover:underline">
          restart
        </button>
      </div>
      </>
      )}
    </li>
  );
}

function ReviewSession(p: StudyProps & { deckId: number; onExit: () => void }) {
  const [deck, setDeck] = useState<ArtifactDetail | null>(null);
  const [queue, setQueue] = useState<CardItem[] | null>(null);
  const [nextDue, setNextDue] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [done, setDone] = useState(0);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.artifact(p.deckId).then(setDeck);
    api.reviewQueue(p.deckId).then((r) => {
      setQueue(r.cards);
      setNextDue(r.next_due_at);
    });
  }, [p.deckId]);

  const card = queue?.[0];

  const grade = useCallback(
    async (g: Grade) => {
      if (!card || saving) return;
      setSaving(true);
      try {
        tap(g === "again" ? "error" : "light");
        const updated = await api.gradeCard(card.id, g);
        setQueue((q) => {
          const rest = (q ?? []).slice(1);
          return g === "again" ? [...rest, updated] : rest; // "again" comes back this session
        });
        setDone((n) => n + 1);
        setRevealed(false);
      } finally {
        setSaving(false);
      }
    },
    [card, saving],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "TEXTAREA" || (e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        setRevealed(true);
      } else if (revealed && ["1", "2", "3", "4"].includes(e.key)) {
        grade((["again", "hard", "good", "easy"] as Grade[])[Number(e.key) - 1]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [revealed, grade]);

  const total = done + (queue?.length ?? 0);
  return (
    <div className="mx-auto flex max-w-2xl flex-col px-4 pt-6 sm:px-6 sm:pt-8">
      <div className="flex items-center gap-4">
        <button type="button" onClick={p.onExit} className="btn-ghost">
          ← Decks
        </button>
        <p className="min-w-0 flex-1 truncate font-display text-lg">{deck?.title ?? "…"}</p>
        {queue && <p className="text-sm text-muted">{queue.length} left</p>}
      </div>
      <div className="mt-3 h-1 overflow-hidden rounded-full bg-sunken">
        <div className="h-full bg-moss transition-all" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
      </div>

      {queue === null ? (
        <p className="mt-10 text-muted">Loading…</p>
      ) : !card ? (
        <div className="mt-16 text-center">
          <p className="font-display text-3xl">All caught up.</p>
          <p className="mt-2 text-muted">
            {done ? `You reviewed ${done} card${done === 1 ? "" : "s"}. ` : ""}
            {nextDue ? `Next card is due ${timeUntil(nextDue)}.` : ""}
          </p>
          <button type="button" onClick={p.onExit} className="btn-primary mt-6">
            Back to decks
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setRevealed(true)}
            className="mt-6 min-h-[260px] rounded border border-line bg-card p-5 text-left transition-colors hover:border-muted sm:p-8"
          >
            <p className="text-[11px] uppercase tracking-[0.12em] text-muted">{card.is_new ? "New" : "Review"}</p>
            <p className="mt-3 font-display text-2xl leading-snug"><MathText text={card.front} /></p>
            {revealed ? (
              <div className="mt-6 border-t border-dashed border-line pt-5 font-reading text-[1.05rem] leading-relaxed">
                <MathText text={card.back} />{" "}
                {deck && <CiteMarks cite={card.cite} passages={deck.passages} onCite={p.onCite} />}
              </div>
            ) : (
              <p className="mt-10 text-sm text-muted">Answer in your head, then tap or press Space to check.</p>
            )}
          </button>
          {revealed && (
            <div className="mt-5 grid grid-cols-4 gap-2">
              {(["again", "hard", "good", "easy"] as Grade[]).map((g, i) => (
                <button
                  key={g}
                  type="button"
                  disabled={saving}
                  onClick={() => grade(g)}
                  className={`min-h-14 rounded border px-2 py-3 text-center transition-colors ${
                    g === "again"
                      ? "border-danger/40 hover:bg-danger-soft"
                      : g === "good"
                        ? "border-moss/50 hover:bg-moss/10"
                        : "border-line hover:bg-sunken"
                  }`}
                >
                  <span className="block font-medium capitalize">{g === "again" ? "Forgot" : g}</span>
                  <span className="block text-xs text-muted">
                    {card.next[g]} · {i + 1}
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function BrowseDeck(p: StudyProps & { deckId: number; onExit: () => void }) {
  const [deck, setDeck] = useState<ArtifactDetail | null>(null);
  useEffect(() => {
    api.artifact(p.deckId).then(setDeck);
  }, [p.deckId]);
  return (
    <div className="mx-auto max-w-3xl px-6 pt-8">
      <button type="button" onClick={p.onExit} className="btn-ghost">
        ← Decks
      </button>
      <h1 className="mt-4 font-display text-3xl">{deck?.title ?? "…"}</h1>
      <ol className="mt-6 divide-y divide-line border-y border-line">
        {deck?.cards?.map((c, i) => (
          <li key={c.id} className="grid gap-1 py-4 sm:grid-cols-[2rem_1fr_1fr] sm:gap-4">
            <span className="text-sm text-muted">{i + 1}</span>
            <p className="font-medium"><MathText text={c.front} /></p>
            <p className="font-reading text-ink-soft">
              <MathText text={c.back} /> <CiteMarks cite={c.cite} passages={deck.passages} onCite={p.onCite} />
              <span className="mt-1 block font-sans text-xs text-muted">
                {c.is_new ? "new" : `next ${timeUntil(c.due_at)}`}
                {c.lapses ? ` · forgotten ${c.lapses}×` : ""}
              </span>
            </p>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------- quizzes

function Quizzes(p: StudyProps & { onOpen: (id: number) => void }) {
  const { items, busy, notice, error, setError, generate, remove, retry, retryLast } = useArtifacts(p.subjectId, "quiz");
  const [focus, setFocus] = useState("");
  const [count, setCount] = useState<"5" | "8" | "12">("8");
  const [difficulty, setDifficulty] = useState<"easy" | "medium" | "hard">("medium");
  const [types, setTypes] = useState<QType[]>(["mcq"]);
  const toggle = (t: QType) =>
    setTypes((cur) => (cur.includes(t) ? (cur.length > 1 ? cur.filter((x) => x !== t) : cur) : [...cur, t]));

  return (
    <>
      <form
        className="mt-8 rounded-2xl border border-line bg-card p-5"
        onSubmit={async (e) => {
          e.preventDefault();
          await generate(
            { source_ids: p.checkedIds, focus: focus || null, count: Number(count), difficulty, types },
            "Quiz:",
            { openWhenReady: p.onOpen },
          );
        }}
      >
        <p className="font-display text-xl">New quiz</p>
        <p className="mt-1 text-sm text-muted">
          From {scopeLabel(p.checkedIds.length, p.totalSources)}, with an explanation and source for every answer.
          Short and written answers are marked for you.
        </p>
        <div className="mt-4">
          <p className="mb-2 text-sm font-medium">Question types <span className="font-normal text-muted">(pick one or more)</span></p>
          <div className="grid gap-2 sm:grid-cols-3">
            {QTYPES.map((t) => {
              const on = types.includes(t.value);
              return (
                <button
                  key={t.value}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => toggle(t.value)}
                  className={`flex min-h-11 items-start gap-2.5 rounded border px-3 py-2.5 text-left transition-colors ${
                    on ? "border-accent bg-accent-soft" : "border-line hover:border-muted"
                  }`}
                >
                  <span className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border text-[10px] ${on ? "border-moss bg-moss text-on-accent" : "border-muted"}`}>
                    {on ? "✓" : ""}
                  </span>
                  <span>
                    <span className="block font-medium">{t.label}</span>
                    <span className="block text-xs text-muted">{t.blurb}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <input
          value={focus}
          onChange={(e) => setFocus(e.target.value)}
          placeholder="Focus on… (optional)"
          className="field mt-4 min-h-11 w-full"
        />
        <div className="mt-4 flex flex-wrap items-end gap-x-6 gap-y-3 [&_button]:min-h-11">
          <div>
            <p className="mb-1.5 text-sm font-medium">Difficulty</p>
            <Segmented
              label="Difficulty"
              value={difficulty}
              onChange={setDifficulty}
              options={[
                { value: "easy", label: "Recall" },
                { value: "medium", label: "Understand" },
                { value: "hard", label: "Apply" },
              ]}
            />
          </div>
          <div>
            <p className="mb-1.5 text-sm font-medium">Questions</p>
            <Segmented
              label="Questions"
              value={count}
              onChange={setCount}
              options={[
                { value: "5", label: "5" },
                { value: "8", label: "8" },
                { value: "12", label: "12" },
              ]}
            />
          </div>
          <button className="btn-primary w-full sm:ml-auto sm:w-auto" disabled={!!busy || !p.checkedIds.length}>
            Make quiz
          </button>
        </div>
        <Working label={busy} notice={notice} />
        {error && <ErrorNote text={error} onClose={() => setError(null)} onRetry={retryLast} />}
      </form>

      <section className="mt-8">
        {items === null ? (
          <p className="text-muted">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-muted">No quizzes yet.</p>
        ) : (
          <ul className="divide-y divide-line border-y border-line">
            {items.map((q) => (
              <li key={q.id} className="group flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
                <button type="button" onClick={() => isReady(q) && p.onOpen(q.id)} className="min-h-11 min-w-0 flex-1 basis-56 text-left">
                  <p className="truncate font-display text-lg group-hover:text-accent"><MathText text={q.title} /></p>
                  {!isReady(q) ? (
                    <JobStatus a={q} onRetry={retry} />
                  ) : (
                    <p className="text-xs text-muted">
                      {q.question_count} questions · {(q.types ?? ["mcq"]).map(typeLabel).join(" + ")} ·{" "}
                      {DIFFICULTY_LABEL[q.params.difficulty ?? "medium"]}
                      {q.params.focus ? ` · ${q.params.focus}` : ""}
                    </p>
                  )}
                </button>
                <span className="text-sm text-muted">
                  {q.best != null ? `best ${q.best}/${q.total_marks ?? q.question_count}` : "not taken"}
                </span>
                {isReady(q) && (
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() =>
                      void generate(similarRequest(q, p.checkedIds), "Quiz:", { openWhenReady: p.onOpen })
                    }
                    className="min-h-11 text-sm text-accent underline-offset-2 hover:underline disabled:opacity-50"
                  >
                    Another quiz like this
                  </button>
                )}
                <button type="button" title="Delete quiz" onClick={() => askConfirm(`Delete “${q.title}”?`).then((ok) => { if (ok) void remove(q.id); })} className="text-muted opacity-0 hover:text-danger group-hover:opacity-100">
                  <TrashIcon width={16} height={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
