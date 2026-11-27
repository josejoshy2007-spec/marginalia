"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type SVGProps } from "react";
import { tap } from "@/lib/native";
import {
  api,
  type ArtifactDetail,
  type ArtifactSummary,
  type GenerateRequest,
  type QuizQuestion,
  type QuizResult,
} from "@/lib/api";
import { CiteMarks, ErrorNote, Segmented, useArtifacts, Working, type StudyProps } from "./study/shared";
import { MathText } from "./AnswerBody";
import PracticeTimer from "./PracticeTimer";
import PhotoButton from "./PhotoButton";

export type QType = "mcq" | "short" | "long";
export const QTYPES: { value: QType; label: string; blurb: string }[] = [
  { value: "mcq", label: "Multiple choice", blurb: "Pick A–D" },
  { value: "short", label: "Short answer", blurb: "A word or phrase" },
  { value: "long", label: "Written explanation", blurb: "A few sentences, marked" },
];
export const typeLabel = (t: string) => QTYPES.find((x) => x.value === t)?.label ?? t;
export const DIFFICULTY_LABEL: Record<string, string> = { easy: "Recall", medium: "Understand", hard: "Apply" };

type Answer = number | string | null;

/**
 * The request that makes a new quiz "like" an existing one: same sources, focus, count, difficulty and
 * question types. `avoid` lists the current question stems so the generator can skip repeating them.
 * (The prompt builders ignore `avoid` until they learn about it; unknown params are harmless.)
 */
export function similarRequest(
  q: Pick<ArtifactSummary, "params" | "types" | "question_count">,
  fallbackSourceIds: number[],
  avoid?: string[],
): Omit<GenerateRequest, "kind"> {
  const req: Omit<GenerateRequest, "kind"> = {
    source_ids: q.params.source_ids?.length ? q.params.source_ids : fallbackSourceIds,
    focus: q.params.focus ?? null,
    count: q.params.count ?? q.question_count ?? 8,
    difficulty: (q.params.difficulty as GenerateRequest["difficulty"]) ?? "medium",
    types: ((q.types?.length ? q.types : ["mcq"]) as QType[]),
  };
  if (avoid?.length) req.avoid = avoid.slice(0, 30).map((s) => s.replace(/\s+/g, " ").trim().slice(0, 160));
  return req;
}

const Icon = ({ d, ...p }: SVGProps<SVGSVGElement> & { d: string }) => (
  <svg viewBox="0 0 16 16" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="square" aria-hidden {...p}>
    <path d={d} />
  </svg>
);
const CheckMark = (p: SVGProps<SVGSVGElement>) => <Icon d="M3 8.5l3.5 3.5L13 4.5" {...p} />;
const CrossMark = (p: SVGProps<SVGSVGElement>) => <Icon d="M4 4l8 8M12 4l-8 8" {...p} />;

const isAnswered = (a: Answer | undefined) => (typeof a === "number" ? a >= 0 : !!a && a.trim() !== "");
const kindOf = (q: QuizQuestion) => q.type ?? "mcq";
const blank = (qs: QuizQuestion[]): Answer[] => qs.map((q) => (kindOf(q) === "mcq" ? -1 : ""));

export default function QuizRunner(p: StudyProps & { quizId: number; onExit: () => void; onOpen: (id: number) => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [quiz, setQuiz] = useState<ArtifactDetail | null>(null);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [result, setResult] = useState<QuizResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkErr, setCheckErr] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [filter, setFilter] = useState<"all" | "wrong">("all");
  const more = useArtifacts(p.subjectId, "quiz");

  useEffect(() => {
    setQuiz(null);
    setResult(null);
    setFilter("all");
    setActive(0);
    api.artifact(p.quizId).then((q) => {
      setQuiz(q);
      setAnswers(blank(q.content.questions ?? []));
    });
  }, [p.quizId]);

  // Focus mode: the floating "Ask or make…" bar would sit on top of the action bar, so hide it while a quiz is open.
  useEffect(() => {
    const el = document.createElement("style");
    el.textContent = "main > .pointer-events-none.absolute.bottom-0.z-40 { display: none; }";
    document.head.appendChild(el);
    return () => el.remove();
  }, []);

  const questions = useMemo(() => quiz?.content.questions ?? [], [quiz]);
  const set = (qi: number, v: Answer) => setAnswers((a) => a.map((x, i) => (i === qi ? v : x)));
  const answered = answers.filter(isAnswered).length;
  const hasWritten = questions.some((q) => kindOf(q) !== "mcq");
  const scrollTop = () => document.getElementById("mode-scroll")?.scrollTo({ top: 0, behavior: "smooth" });

  const check = async () => {
    setChecking(true);
    setCheckErr(null);
    try {
      const r = await api.submitAttempt(p.quizId, answers.map((a) => (a === -1 || a === "" ? null : a)), result?.attempt_id);
      setResult(r);
      tap(r.score >= r.total / 2 ? "success" : "error");
      scrollTop();
    } catch (e) {
      setCheckErr((e as Error).message);
    } finally {
      setChecking(false);
    }
  };

  const goTo = useCallback((i: number) => {
    const el = document.getElementById(`quiz-q-${i}`);
    if (!el) {
      document.getElementById("quiz-check")?.focus();
      return;
    }
    setActive(i);
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.focus({ preventScroll: true });
  }, []);

  // 1–4 / A–D choose an option on the active question; Enter moves to the next one.
  useEffect(() => {
    if (result) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) return;
      if (t !== document.body && !t.closest("[data-q]")) return;
      const q = questions[active];
      if (!q) return;
      if (e.key === "Enter") {
        if (isAnswered(answers[active]) || kindOf(q) !== "mcq") {
          e.preventDefault();
          goTo(active + 1);
        }
        return;
      }
      if (kindOf(q) !== "mcq") return;
      const idx = /^[1-9]$/.test(e.key) ? Number(e.key) - 1 : /^[a-iA-I]$/.test(e.key) ? e.key.toLowerCase().charCodeAt(0) - 97 : -1;
      if (idx >= 0 && idx < (q.options?.length ?? 0)) {
        e.preventDefault();
        tap("light");
        set(active, idx);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [result, questions, active, answers, goTo]);

  const wrong = (qi: number) => {
    const r = result?.results?.[qi];
    if (!r) return false;
    return !!r.pending || (kindOf(questions[qi]) === "long" ? r.marks < r.max : !r.correct);
  };
  const wrongCount = result ? questions.filter((_, i) => wrong(i)).length : 0;
  const pendingCount = result?.results?.filter((r) => r.pending).length ?? 0;
  const pct = result && result.total ? Math.round((result.score / result.total) * 100) : 0;

  const another = () => {
    void more.generate(
      similarRequest(quiz ?? ({ params: {}, question_count: questions.length } as ArtifactSummary), p.checkedIds, questions.map((q) => q.question)),
      "Quiz:",
      { openWhenReady: p.onOpen },
    );
  };

  const meta = quiz
    ? [
        quiz.params.focus,
        DIFFICULTY_LABEL[quiz.params.difficulty ?? "medium"],
        `${questions.length} question${questions.length === 1 ? "" : "s"}`,
        (quiz.types ?? ["mcq"]).map(typeLabel).join(" + "),
      ].filter(Boolean)
    : [];

  return (
    <div ref={rootRef} className="mx-auto max-w-3xl px-4 pt-6 sm:px-6 sm:pt-8">
      <button type="button" onClick={p.onExit} className="btn-ghost min-h-11">
        ← Quizzes
      </button>
      {!result && (
        <div className="mt-2 flex justify-end">
          <PracticeTimer />
        </div>
      )}

      <header className="mt-3">
        <h1 className="font-display text-2xl leading-tight sm:text-3xl">
          {quiz ? <MathText text={quiz.title} /> : "…"}
        </h1>
        {meta.length > 0 && <p className="mt-1 text-sm text-muted">{meta.join(" · ")}</p>}
        {!result && questions.length > 0 && (
          <div className="mt-4 flex items-center gap-3">
            <div
              className="h-1 flex-1 overflow-hidden rounded-full bg-sunken"
              role="progressbar"
              aria-label="Questions answered"
              aria-valuemin={0}
              aria-valuemax={questions.length}
              aria-valuenow={answered}
            >
              <div className="h-full bg-accent transition-all" style={{ width: `${(answered / questions.length) * 100}%` }} />
            </div>
            <span className="text-sm tabular-nums text-muted">
              {answered} / {questions.length}
            </span>
          </div>
        )}
      </header>

      {result && (
        <section className="mt-5 rounded border border-line bg-card p-4 sm:p-5" aria-label="Your result">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <p className="font-display text-4xl tabular-nums">
              {result.score}
              <span className="text-xl text-muted">/{result.total}</span>
            </p>
            <p className="font-display text-xl tabular-nums text-ink-soft">{pct}%</p>
            <p className="text-sm text-muted">
              {wrongCount === 0 ? "Every question right." : `${wrongCount} to review.`}
            </p>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded bg-sunken" role="progressbar" aria-label="Score" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <div className="h-full bg-moss" style={{ width: `${pct}%` }} />
          </div>
          {pendingCount > 0 && (
            <p className="mt-3 text-sm text-danger">
              {pendingCount === 1 ? "One answer" : `${pendingCount} answers`} couldn't be marked yet.{" "}
              <button type="button" className="min-h-11 underline" disabled={checking} onClick={check}>
                Try again
              </button>
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button type="button" className="btn-primary min-h-11" disabled={!!more.busy} onClick={another}>
              Another quiz like this
            </button>
            <button
              type="button"
              className="btn-ghost min-h-11"
              onClick={() => {
                setResult(null);
                setAnswers(blank(questions));
                setFilter("all");
                setActive(0);
                scrollTop();
              }}
            >
              Retake
            </button>
            <button type="button" className="btn-ghost min-h-11" onClick={p.onExit}>
              Back to quizzes
            </button>
          </div>
          <Working label={more.busy} notice={more.notice} />
          {more.error && <ErrorNote text={more.error} onClose={() => more.setError(null)} onRetry={more.retryLast} />}
          <div className="mt-4 border-t border-line pt-4">
            <Segmented
              label="Show"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: `All ${questions.length}` },
                { value: "wrong", label: `Wrong only (${wrongCount})` },
              ]}
            />
          </div>
        </section>
      )}

      <ol className="mt-5 space-y-4">
        {questions.map((q, qi) => {
          const kind = kindOf(q);
          const r = result?.results?.[qi];
          if (result && filter === "wrong" && !wrong(qi)) return null;
          const value = answers[qi];
          const text = typeof value === "string" ? value : "";
          return (
            <li
              key={qi}
              id={`quiz-q-${qi}`}
              data-q
              tabIndex={-1}
              onFocusCapture={() => setActive(qi)}
              onPointerDown={() => setActive(qi)}
              className={`scroll-mt-4 rounded border bg-card p-4 outline-none transition-colors sm:p-5 ${
                !result && active === qi ? "border-muted" : "border-line"
              }`}
            >
              <div className="flex items-start gap-3">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded bg-sunken text-sm font-semibold tabular-nums">{qi + 1}</span>
                <p className="min-w-0 flex-1 pt-0.5 font-medium leading-relaxed">
                  <MathText text={q.question} />
                </p>
                {kind === "long" && (
                  <span className="shrink-0 whitespace-nowrap pt-1 text-sm font-semibold text-ink-soft">
                    [{q.marks} mark{q.marks === 1 ? "" : "s"}]
                  </span>
                )}
              </div>

              {kind === "mcq" ? (
                <div role="radiogroup" aria-label={`Question ${qi + 1}`} className="mt-4 grid gap-2">
                  {(q.options ?? []).map((opt, oi) => {
                    const chosen = value === oi;
                    const right = !!result && oi === q.answer;
                    const bad = !!result && chosen && oi !== q.answer;
                    const state = right ? "right" : bad ? "wrong" : chosen ? "chosen" : "";
                    return (
                      <button
                        key={oi}
                        type="button"
                        role="radio"
                        aria-checked={chosen}
                        disabled={!!result}
                        onClick={() => {
                          tap("light");
                          set(qi, oi);
                        }}
                        className={`flex min-h-11 w-full items-center gap-3 rounded border px-3 py-2 text-left transition-colors disabled:cursor-default ${
                          state === "chosen"
                            ? "border-accent bg-accent-soft"
                            : state === "right"
                              ? "border-moss bg-moss/10"
                              : state === "wrong"
                                ? "border-danger bg-danger-soft"
                                : "border-line hover:border-muted enabled:hover:bg-sunken"
                        }`}
                      >
                        <span
                          className={`grid h-7 w-7 shrink-0 place-items-center rounded border text-sm font-semibold ${
                            state === "chosen"
                              ? "border-accent bg-accent text-on-accent"
                              : state === "right"
                                ? "border-moss bg-moss text-on-accent"
                                : state === "wrong"
                                  ? "border-danger bg-danger text-on-accent"
                                  : "border-line text-muted"
                          }`}
                        >
                          {String.fromCharCode(65 + oi)}
                        </span>
                        <span className="min-w-0 flex-1 leading-snug">
                          <MathText text={opt} />
                        </span>
                        {right && (
                          <span className="flex shrink-0 items-center gap-1 text-sm font-medium text-moss">
                            <CheckMark />
                            <span className="sr-only sm:not-sr-only">{chosen ? "Correct" : "Right answer"}</span>
                          </span>
                        )}
                        {bad && (
                          <span className="flex shrink-0 items-center gap-1 text-sm font-medium text-danger">
                            <CrossMark />
                            <span className="sr-only sm:not-sr-only">Your answer</span>
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ) : kind === "short" ? (
                <input
                  value={text}
                  onChange={(e) => set(qi, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !result) {
                      e.preventDefault();
                      goTo(qi + 1);
                    }
                  }}
                  disabled={!!result}
                  aria-label={`Answer to question ${qi + 1}`}
                  placeholder={result ? "No answer given" : "A word or short phrase…"}
                  className={`field mt-4 min-h-11 w-full ${r ? (r.correct ? "border-moss" : "border-danger") : ""}`}
                />
              ) : (
                <textarea
                  value={text}
                  onChange={(e) => set(qi, e.target.value)}
                  disabled={!!result}
                  rows={5}
                  aria-label={`Answer to question ${qi + 1}`}
                  placeholder={result ? "No answer given" : "Explain in a few sentences…"}
                  className="field mt-4 w-full resize-y font-reading leading-relaxed"
                />
              )}

              {result && r && (
                <div className="mt-4 space-y-2 border-t border-line pt-3 text-sm leading-relaxed text-ink-soft">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {(() => {
                      const full = kind === "long" ? r.marks >= r.max : r.correct;
                      const part = kind === "long" && r.marks > 0 && !full;
                      const skipped = !isAnswered(value);
                      const tone = full ? "text-moss" : part ? "text-accent" : "text-danger";
                      return (
                        <span className={`flex items-center gap-1.5 font-semibold ${tone}`}>
                          {full ? <CheckMark /> : <CrossMark />}
                          {kind === "long"
                            ? `${r.marks}/${r.max ?? q.marks} marks`
                            : full
                              ? "Correct"
                              : skipped
                                ? "Skipped"
                                : "Not quite"}
                        </span>
                      );
                    })()}
                    {r.feedback && (
                      <span>
                        <MathText text={r.feedback} />
                      </span>
                    )}
                  </p>
                  {r.pending && (
                    <p className="text-danger">
                      Couldn't mark this one yet.{" "}
                      <button type="button" className="min-h-11 underline" disabled={checking} onClick={check}>
                        Try again
                      </button>
                    </p>
                  )}
                  {kind === "short" && !r.correct && (q.accept?.length ?? 0) > 0 && (
                    <p>
                      <span className="font-medium text-ink">Accepted: </span>
                      {q.accept!.map((a, j) => (
                        <span key={j}>
                          {j > 0 && " / "}
                          <MathText text={a} />
                        </span>
                      ))}
                    </p>
                  )}
                  {kind === "long" && (q.points?.length ?? 0) > 0 && (
                    <ul className="space-y-1.5">
                      {q.points!.map((pt, j) => {
                        const got = r.points?.[j] ?? 0;
                        return (
                          <li key={j} className="flex items-start gap-2">
                            <span
                              className={`mt-0.5 flex h-5 min-w-8 shrink-0 items-center justify-center gap-0.5 rounded px-1 text-[11px] font-semibold ${
                                got > 0 ? "bg-moss text-on-accent" : "bg-danger-soft text-danger"
                              }`}
                            >
                              {got > 0 ? <CheckMark width={11} height={11} /> : <CrossMark width={11} height={11} />}
                              {got > 0 ? got : pt.marks}
                            </span>
                            <span className="min-w-0 flex-1">
                              <MathText text={pt.text} />
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  <p>
                    <MathText text={q.explanation} />{" "}
                    {quiz && <CiteMarks cite={q.cite} passages={quiz.passages} onCite={p.onCite} />}
                  </p>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {result && filter === "wrong" && wrongCount === 0 && (
        <p className="mt-5 rounded border border-line bg-card p-4 text-sm text-muted">Nothing wrong here. Switch to All to see every question.</p>
      )}

      {!result && questions.length > 0 && (
        <p className="mt-4 hidden text-xs text-muted sm:block">Press 1–4 or A–D to choose an answer, Enter for the next question.</p>
      )}

      {!result && questions.length > 0 && (
        <div className="sticky -bottom-40 z-30 -mx-4 mt-6 border-t border-line bg-paper px-4 py-3 sm:-mx-6 sm:px-6">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 [&_button]:min-h-11">
            <span className="w-full text-sm tabular-nums text-muted sm:mr-auto sm:w-auto">
              {answered} of {questions.length} answered
            </span>
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap [&_button]:min-h-11">
            <PhotoButton
              pasteScope={rootRef}
              label="Photo of my answers"
              busyLabel="Reading your answers…"
              onPhotos={async (files) => {
                const r = await api.quizPhoto(p.quizId, files);
                setAnswers((cur) => r.answers.map((a, i) => (a === null || a === -1 ? cur[i] : a)));
              }}
            />
            <button id="quiz-check" type="button" className="btn-primary flex-1 sm:flex-none" disabled={checking || answered === 0} onClick={check}>
              {checking ? (hasWritten ? "Marking your answers…" : "Checking…") : "Check answers"}
            </button>
            </div>
          </div>
          {checkErr && <ErrorNote text={checkErr} onClose={() => setCheckErr(null)} onRetry={check} />}
        </div>
      )}
    </div>
  );
}
