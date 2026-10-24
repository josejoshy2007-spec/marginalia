"use client";

import { useCallback, useEffect, useState } from "react";
import { tap } from "@/lib/native";
import { api, type ArtifactDetail, type ArtifactSummary, type CardItem, type Grade, type QuizQuestion, type QuizResult } from "@/lib/api";
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
import PhotoButton from "./PhotoButton";
import { askConfirm } from "@/lib/confirm";

type Tab = "cards" | "quiz" | "exam";
type Open = { kind: "review" | "browse" | "quiz" | "exam"; id: number } | null;

export default function PracticeMode(p: StudyProps) {
  const [tab, setTab] = useState<Tab>("cards");
  const [open, setOpen] = useState<Open>(null);

  if (open?.kind === "review") return <ReviewSession {...p} deckId={open.id} onExit={() => setOpen(null)} />;
  if (open?.kind === "browse") return <BrowseDeck {...p} deckId={open.id} onExit={() => setOpen(null)} />;
  if (open?.kind === "quiz") return <QuizRunner {...p} quizId={open.id} onExit={() => setOpen(null)} />;
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
    <div className="mx-auto flex max-w-2xl flex-col px-6 pt-8">
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
            className="mt-8 min-h-[280px] rounded-3xl border border-line bg-card p-8 text-left shadow-sm transition-shadow hover:shadow-md"
          >
            <p className="text-xs uppercase tracking-[0.16em] text-muted">{card.is_new ? "New" : "Review"}</p>
            <p className="mt-3 font-display text-2xl leading-snug">{card.front}</p>
            {revealed ? (
              <div className="mt-6 border-t border-dashed border-line pt-5 font-reading text-[1.05rem] leading-relaxed">
                {card.back}{" "}
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
                  className={`rounded-2xl border px-2 py-3 text-center transition-colors ${
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
            <p className="font-medium">{c.front}</p>
            <p className="font-reading text-ink-soft">
              {c.back} <CiteMarks cite={c.cite} passages={deck.passages} onCite={p.onCite} />
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

type QType = "mcq" | "short" | "long";
const QTYPES: { value: QType; label: string; blurb: string }[] = [
  { value: "mcq", label: "Multiple choice", blurb: "Pick A–D" },
  { value: "short", label: "Short answer", blurb: "A word or phrase" },
  { value: "long", label: "Written explanation", blurb: "A few sentences, marked" },
];
const typeLabel = (t: string) => QTYPES.find((x) => x.value === t)?.label ?? t;
type Answer = number | string | null;

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
          <p className="mb-2 text-xs uppercase tracking-[0.14em] text-muted">Question types (pick one or more)</p>
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
                  className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                    on ? "border-ink bg-sunken" : "border-line hover:border-muted"
                  }`}
                >
                  <span className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border text-[10px] ${on ? "border-moss bg-moss text-white" : "border-muted"}`}>
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
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <input
            value={focus}
            onChange={(e) => setFocus(e.target.value)}
            placeholder="Focus on… (optional)"
            className="field min-w-[200px] flex-1"
          />
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
          <button className="btn-primary" disabled={!!busy || !p.checkedIds.length}>
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
              <li key={q.id} className="group flex items-center gap-4 py-3">
                <button type="button" onClick={() => isReady(q) && p.onOpen(q.id)} className="min-w-0 flex-1 text-left">
                  <p className="truncate font-display text-lg group-hover:text-accent">{q.title}</p>
                  {!isReady(q) ? (
                    <JobStatus a={q} onRetry={retry} />
                  ) : (
                    <p className="text-xs text-muted">
                      {q.question_count} questions · {(q.types ?? ["mcq"]).map(typeLabel).join(" + ")} ·{" "}
                      {({ easy: "Recall", medium: "Understand", hard: "Apply" } as Record<string, string>)[q.params.difficulty ?? "medium"]}
                      {q.params.focus ? ` · ${q.params.focus}` : ""}
                    </p>
                  )}
                </button>
                <span className="text-sm text-muted">
                  {q.best != null ? `best ${q.best}/${q.total_marks ?? q.question_count}` : "not taken"}
                </span>
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

function QuizRunner(p: StudyProps & { quizId: number; onExit: () => void }) {
  const [quiz, setQuiz] = useState<ArtifactDetail | null>(null);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [result, setResult] = useState<QuizResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkErr, setCheckErr] = useState<string | null>(null);

  const blank = (qs: QuizQuestion[]): Answer[] => qs.map((q) => ((q.type ?? "mcq") === "mcq" ? -1 : ""));
  useEffect(() => {
    api.artifact(p.quizId).then((q) => {
      setQuiz(q);
      setAnswers(blank(q.content.questions ?? []));
    });
  }, [p.quizId]);

  const questions = quiz?.content.questions ?? [];
  const set = (qi: number, v: Answer) => setAnswers((a) => a.map((x, i) => (i === qi ? v : x)));
  const answered = answers.filter((a) => (typeof a === "number" ? a >= 0 : !!a && a.trim() !== "")).length;
  const hasWritten = questions.some((q) => (q.type ?? "mcq") !== "mcq");

  const check = async () => {
    setChecking(true);
    setCheckErr(null);
    try {
      const r = await api.submitAttempt(p.quizId, answers.map((a) => (a === -1 || a === "" ? null : a)));
      setResult(r);
      tap(r.score >= r.total / 2 ? "success" : "error");
      document.getElementById("mode-scroll")?.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      setCheckErr((e as Error).message);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-6 pt-8">
      <button type="button" onClick={p.onExit} className="btn-ghost">
        ← Quizzes
      </button>
      <h1 className="mt-4 font-display text-3xl">{quiz?.title ?? "…"}</h1>
      {result && (
        <div className="mt-5 flex items-center gap-4 rounded-2xl border border-line bg-card px-5 py-4">
          <p className="font-display text-4xl">
            {result.score}
            <span className="text-xl text-muted">/{result.total}</span>
          </p>
          <p className="flex-1 text-sm text-muted">
            {result.score === result.total
              ? "Perfect. Try a harder quiz next."
              : "Read the feedback below, and tap the numbers to see the passage."}
          </p>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              setResult(null);
              setAnswers(blank(questions));
              document.getElementById("mode-scroll")?.scrollTo({ top: 0, behavior: "smooth" });
            }}
          >
            Retake
          </button>
        </div>
      )}

      <ol className="mt-6 space-y-8">
        {questions.map((q, qi) => {
          const kind = q.type ?? "mcq";
          const r = result?.results?.[qi];
          return (
            <li key={qi}>
              <p className="font-medium">
                <span className="mr-2 text-muted">{qi + 1}.</span>
                {q.question}
                {kind === "long" && <span className="ml-1 whitespace-nowrap font-semibold">[{q.marks}]</span>}
              </p>
              {kind === "mcq" ? (
                <div className="mt-3 grid gap-2">
                  {(q.options ?? []).map((opt, oi) => {
                    const chosen = answers[qi] === oi;
                    const state = !result ? (chosen ? "chosen" : "") : oi === q.answer ? "right" : chosen ? "wrong" : "";
                    return (
                      <button
                        key={oi}
                        type="button"
                        disabled={!!result}
                        onClick={() => set(qi, oi)}
                        className={`flex items-start gap-3 rounded-xl border px-4 py-2.5 text-left transition-colors ${
                          state === "chosen"
                            ? "border-ink bg-sunken"
                            : state === "right"
                              ? "border-moss bg-moss/10"
                              : state === "wrong"
                                ? "border-danger bg-danger-soft"
                                : "border-line bg-card hover:border-muted"
                        }`}
                      >
                        <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border border-current text-[11px]">
                          {String.fromCharCode(65 + oi)}
                        </span>
                        <span>{opt}</span>
                      </button>
                    );
                  })}
                </div>
              ) : kind === "short" ? (
                <input
                  value={typeof answers[qi] === "string" ? (answers[qi] as string) : ""}
                  onChange={(e) => set(qi, e.target.value)}
                  disabled={!!result}
                  placeholder="A word or short phrase…"
                  className={`field mt-3 w-full max-w-md ${r ? (r.correct ? "border-moss" : "border-danger") : ""}`}
                />
              ) : (
                <textarea
                  value={typeof answers[qi] === "string" ? (answers[qi] as string) : ""}
                  onChange={(e) => set(qi, e.target.value)}
                  disabled={!!result}
                  rows={4}
                  placeholder="Explain in a few sentences…"
                  className="field mt-3 w-full resize-y font-reading leading-relaxed"
                />
              )}
              {result && (
                <div className="mt-3 border-l-2 border-line pl-3 text-sm leading-relaxed text-ink-soft">
                  {kind === "mcq" ? (
                    <p>
                      {r?.correct ? "✓ " : answers[qi] === -1 ? "Skipped. " : "✗ "}
                      {q.explanation}{" "}
                      {quiz && <CiteMarks cite={q.cite} passages={quiz.passages} onCite={p.onCite} />}
                    </p>
                  ) : (
                    <>
                      <p>
                        <span className={`font-semibold ${r?.correct ? "text-moss" : r && r.marks > 0 ? "text-accent" : "text-danger"}`}>
                          {kind === "short" ? (r?.correct ? "✓ Correct" : "✗ Not quite") : `${r?.marks ?? 0}/${r?.max ?? q.marks} marks`}
                        </span>
                        {r?.feedback ? ` · ${r.feedback}` : ""}
                      </p>
                      {kind === "short" && !r?.correct && (q.accept?.length ?? 0) > 0 && (
                        <p className="mt-1">Accepted: {q.accept!.join(" / ")}</p>
                      )}
                      {kind === "long" && (
                        <ul className="mt-2 space-y-1">
                          {(q.points ?? []).map((pt, j) => {
                            const got = r?.points?.[j] ?? 0;
                            return (
                              <li key={j} className="flex items-start gap-2">
                                <span className={`mt-0.5 grid h-5 min-w-5 shrink-0 place-items-center rounded px-1 text-[11px] font-semibold ${got > 0 ? "bg-moss text-white" : "bg-sunken text-muted"}`}>
                                  {got > 0 ? `✓${got}` : `[${pt.marks}]`}
                                </span>
                                <span>{pt.text}</span>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                      <p className="mt-1">
                        {q.explanation} {quiz && <CiteMarks cite={q.cite} passages={quiz.passages} onCite={p.onCite} />}
                      </p>
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {!result && questions.length > 0 && (
        <div className="mt-6 flex flex-wrap items-center gap-3 rounded-2xl border border-dashed border-line px-4 py-3 text-sm text-muted">
          <span>Answered on paper? Number your answers (“1 B”, “2. chlorophyll”, “3. Because…”) and</span>
          <PhotoButton
            label="Photo of my answers"
            busyLabel="Reading your answers…"
            onPhotos={async (files) => {
              const r = await api.quizPhoto(p.quizId, files);
              setAnswers((cur) => r.answers.map((a, i) => (a === null || a === -1 ? cur[i] : a)));
            }}
          />
        </div>
      )}
      {!result && questions.length > 0 && (
        <div className="mt-8 flex flex-wrap items-center gap-3 pb-10">
          <button type="button" className="btn-primary" disabled={checking} onClick={check}>
            {checking ? (hasWritten ? "Marking your answers…" : "Checking…") : "Check answers"}
          </button>
          <span className="text-sm text-muted">
            {answered}/{questions.length} answered
          </span>
          {checkErr && <ErrorNote text={checkErr} onClose={() => setCheckErr(null)} onRetry={check} />}
        </div>
      )}
    </div>
  );
}
