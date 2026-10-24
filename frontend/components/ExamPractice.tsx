"use client";

import { useEffect, useRef, useState } from "react";
import { tap } from "@/lib/native";
import { api, examQuestions, type ArtifactDetail, type ExamQuestion, type MarkResult } from "@/lib/api";
import { CiteMarks, ErrorNote, IBBadge, Segmented, scopeLabel, useArtifacts, Working, type StudyProps } from "./study/shared";
import { isReady, JobStatus } from "./study/shared";
import { TrashIcon } from "./icons";
import PhotoButton from "./PhotoButton";
import { askConfirm } from "@/lib/confirm";

type Size = "short" | "section" | "paper";
const OBJECTIVE = {
  1: "Objective 1 · knowledge & understanding",
  2: "Objective 2 · application & analysis",
  3: "Objective 3 · synthesis & evaluation",
} as Record<number, string>;

/** Practice → Exam questions: IB-style question sets, examiner marking, and marking your own questions. */
export function Exams(p: StudyProps & { onOpen: (id: number) => void }) {
  const { items, busy, notice, error, setError, generate, remove, retry, retryLast } = useArtifacts(p.subjectId, "exam");
  const [focus, setFocus] = useState("");
  const [size, setSize] = useState<Size>("short");
  const [extended, setExtended] = useState(true);
  const [custom, setCustom] = useState(false);

  return (
    <>
      <div className="mt-8 rounded-2xl border border-line bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="font-display text-xl">{custom ? "Mark my own question" : "New exam practice"}</p>
          <div className="flex items-center gap-3">
            <IBBadge label={p.ibLabel} />
            <Segmented
              label="Exam practice type"
              value={custom ? "custom" : "generate"}
              onChange={(v) => setCustom(v === "custom")}
              options={[
                { value: "generate", label: "Write questions" },
                { value: "custom", label: "Mark my question" },
              ]}
            />
          </div>
        </div>
        {!p.ibLabel && (
          <p className="mt-2 text-sm text-muted">
            Tip: set your IB course in the Library (under the subject name) so questions use that course&apos;s style.
          </p>
        )}
        {custom ? (
          <CustomQuestion {...p} onMade={(id) => p.onOpen(id)} />
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const made = await generate(
                { source_ids: p.checkedIds, subtype: size, focus: focus || null, extended },
                "Exam questions:",
                { openWhenReady: p.onOpen },
              );
              void made;
            }}
          >
            <p className="mt-1 text-sm text-muted">
              IB-style questions from {scopeLabel(p.checkedIds.length, p.totalSources)}: command terms, mark values and a
              hidden markscheme. Write your answers and they&apos;re marked the way an IB examiner would.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <input value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="Focus on… (optional topic)" className="field min-w-[200px] flex-1" />
              <Segmented
                label="Length"
                value={size}
                onChange={setSize}
                options={[
                  { value: "short", label: "~15 marks" },
                  { value: "section", label: "~30 marks" },
                  { value: "paper", label: "~50 marks" },
                ]}
              />
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input type="checkbox" checked={extended} onChange={(e) => setExtended(e.target.checked)} className="accent-[var(--accent)]" />
                Extended response
              </label>
              <button className="btn-primary" disabled={!!busy || !p.checkedIds.length}>
                Make questions
              </button>
            </div>
            <Working label={busy} notice={notice} />
            {error && <ErrorNote text={error} onClose={() => setError(null)} onRetry={retryLast} />}
          </form>
        )}
      </div>

      <section className="mt-8">
        {items === null ? (
          <p className="text-muted">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-muted">No exam practice yet.</p>
        ) : (
          <ul className="divide-y divide-line border-y border-line">
            {items.map((x) => (
              <li key={x.id} className="group flex items-center gap-4 py-3">
                <button type="button" onClick={() => isReady(x) && p.onOpen(x.id)} className="min-w-0 flex-1 text-left">
                  <p className="truncate font-display text-lg group-hover:text-accent">{x.title}</p>
                  {!isReady(x) ? <JobStatus a={x} onRetry={retry} /> : <p className="text-xs text-muted">
                    {x.subtype === "custom" ? "Your question" : `${x.question_count} questions`} · [{x.total_marks}] marks
                    {x.params.focus ? ` · ${x.params.focus}` : ""}
                  </p>}
                </button>
                <span className="text-sm text-muted">
                  {x.answered ? `${x.scored}/${x.scored_of} on ${x.answered} answered` : "not attempted"}
                </span>
                <button type="button" title="Delete" onClick={() => askConfirm(`Delete “${x.title}”?`).then((ok) => { if (ok) void remove(x.id); })} className="text-muted opacity-0 hover:text-danger group-hover:opacity-100">
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

function CustomQuestion(p: StudyProps & { onMade: (id: number) => void }) {
  const [question, setQuestion] = useState("");
  const [marks, setMarks] = useState("4");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <form
      ref={formRef}
      className="mt-3 grid gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const made = await api.customQuestion(p.subjectId, {
            question, marks: Number(marks) || 1, answer, source_ids: p.checkedIds,
          });
          p.onMade(made.id);
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="text-sm text-muted">
        Paste a past-paper or teacher question. I&apos;ll write an IB-style markscheme from your sources, then mark
        your answer against it.
      </p>
      <div className="flex flex-wrap gap-2">
        <PhotoButton
          label="Photo of the question"
          busyLabel="Reading the question…"
          onPhotos={async (files) => {
            const r = await api.photoQuestion(files);
            setQuestion(r.text);
            if (r.marks) setMarks(String(r.marks));
          }}
        />
        <PhotoButton
          label="Photo of my answer"
          onPhotos={async (files) => {
            const r = await api.photoAnswer(files, question || undefined);
            setAnswer((prev) => (prev.trim() ? `${prev.trimEnd()}\n${r.text}` : r.text));
          }}
        />
      </div>
      <div className="flex gap-3">
        <textarea value={question} onChange={(e) => setQuestion(e.target.value)} rows={3} placeholder="e.g. Explain why a binary search is faster than a linear search for large sorted arrays." className="field flex-1 resize-y" />
        <label className="flex w-24 shrink-0 flex-col gap-1 text-xs text-muted">
          Marks
          <input value={marks} onChange={(e) => setMarks(e.target.value.replace(/\D/g, "").slice(0, 2))} className="field text-center text-lg" inputMode="numeric" />
        </label>
      </div>
      <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={6} placeholder="Your answer (optional: leave blank to just see the markscheme)" className="field resize-y font-reading" />
      <div className="flex items-center gap-3">
        <button className="btn-primary" disabled={busy || question.trim().length < 5 || !p.checkedIds.length}>
          {answer.trim() ? "Mark my answer" : "Write the markscheme"}
        </button>
        {busy && <span className="text-sm text-muted">Writing the markscheme{answer.trim() ? " and marking" : ""}…</span>}
      </div>
      {error && <ErrorNote text={error} onClose={() => setError(null)} onRetry={() => formRef.current?.requestSubmit()} />}
    </form>
  );
}

export function ExamRunner(p: StudyProps & { examId: number; onExit: () => void }) {
  const [exam, setExam] = useState<ArtifactDetail | null>(null);
  useEffect(() => {
    api.artifact(p.examId).then(setExam);
  }, [p.examId]);
  const questions = exam ? examQuestions(exam) : [];
  const total = questions.reduce((n, q) => n + q.marks, 0);
  const [scores, setScores] = useState<Record<number, number>>({});
  useEffect(() => {
    if (!exam?.marked) return;
    setScores(Object.fromEntries(Object.entries(exam.marked).map(([k, v]) => [Number(k), v.result?.marks_awarded ?? 0])));
  }, [exam]);
  const got = Object.values(scores).reduce((a, b) => a + b, 0);
  const of = Object.keys(scores).reduce((n, k) => n + (questions[Number(k)]?.marks ?? 0), 0);

  return (
    <div className="mx-auto max-w-3xl px-6 pt-8">
      <div className="flex items-center gap-3">
        <button type="button" onClick={p.onExit} className="btn-ghost">
          ← Exam practice
        </button>
        <IBBadge label={p.ibLabel} />
        {of > 0 && (
          <span className="ml-auto text-sm text-muted">
            <span className="font-display text-2xl text-ink">{got}</span>/{of} marked · [{total}] total
          </span>
        )}
      </div>
      <h1 className="mt-4 font-display text-3xl leading-tight">{exam?.title ?? "…"}</h1>
      <p className="mt-1 text-sm text-muted">
        Answer in full sentences, using the command term. The markscheme stays hidden until you submit.
      </p>
      <ol className="mt-6 space-y-10 pb-10">
        {exam &&
          questions.map((q, i) => (
            <QuestionCard
              key={i}
              index={i}
              q={q}
              exam={exam}
              initial={exam.marked?.[String(i)]}
              onMarked={(r) => setScores((s) => ({ ...s, [i]: r.marks_awarded }))}
              onCite={p.onCite}
            />
          ))}
      </ol>
    </div>
  );
}

function QuestionCard({
  index,
  q,
  exam,
  initial,
  onMarked,
  onCite,
}: {
  index: number;
  q: ExamQuestion;
  exam: ArtifactDetail;
  initial?: { answer: string; result: MarkResult | null };
  onMarked: (r: MarkResult) => void;
  onCite: StudyProps["onCite"];
}) {
  const [answer, setAnswer] = useState(initial?.answer ?? "");
  const [result, setResult] = useState<MarkResult | null>(initial?.result ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showScheme, setShowScheme] = useState(!!initial?.result);
  const [photoNote, setPhotoNote] = useState<string | null>(null);
  const words = answer.trim() ? answer.trim().split(/\s+/).length : 0;

  const mark = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.markQuestion(exam.id, index, answer);
      setResult(r);
      tap(r.marks_awarded >= r.max_marks / 2 ? "success" : "error");
      setShowScheme(true);
      onMarked(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 font-display text-xl text-muted">{index + 1}.</span>
        <div className="min-w-0 flex-1">
          <p className="whitespace-pre-wrap font-medium leading-relaxed">
            {q.question} <span className="whitespace-nowrap font-semibold">[{q.marks}]</span>
          </p>
          <p className="mt-1 text-xs text-muted">
            <span className="rounded bg-sunken px-1.5 py-0.5 font-semibold uppercase tracking-wider text-ink-soft">{q.command_term}</span>{" "}
            {OBJECTIVE[q.objective] ?? ""} · {q.markscheme.type === "markbands" ? "markbands" : "point-marked"}{" "}
            <CiteMarks cite={q.cite} passages={exam.passages} onCite={onCite} />
          </p>
        </div>
      </div>

      <textarea
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        rows={q.marks >= 6 ? 10 : q.marks >= 3 ? 5 : 2}
        placeholder="Your answer…"
        className="field mt-3 w-full resize-y font-reading leading-relaxed"
      />
      {photoNote && <p className="mt-2 text-xs text-accent">{photoNote}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button type="button" className="btn-primary" disabled={busy || !answer.trim()} onClick={mark}>
          {busy ? "Marking…" : result ? "Mark again" : "Mark my answer"}
        </button>
        <PhotoButton
          label="Photo of my answer"
          onPhotos={async (files) => {
            const r = await api.photoAnswer(files, q.question);
            setAnswer((prev) => (prev.trim() ? `${prev.trimEnd()}\n${r.text}` : r.text));
            setPhotoNote(
              r.found
                ? "Read from your photo, word for word. Check it matches what you wrote, then mark it."
                : "I couldn't spot this question's answer, so this is everything I could read. Trim it before marking.",
            );
          }}
        />
        <span className="text-xs text-muted">{words} words</span>
        {!result && (
          <button type="button" className="ml-auto text-xs text-muted underline-offset-2 hover:underline" onClick={() => setShowScheme((v) => !v)}>
            {showScheme ? "hide markscheme" : "peek at markscheme"}
          </button>
        )}
      </div>
      {error && <ErrorNote text={error} onClose={() => setError(null)} onRetry={mark} />}

      {result && (
        <div className="mt-4 rounded-2xl border border-line bg-card p-4">
          <div className="flex items-baseline gap-3">
            <p className="font-display text-3xl">
              {result.marks_awarded}
              <span className="text-lg text-muted">/{result.max_marks}</span>
            </p>
            {result.band && <span className="text-sm text-muted">Markband {result.band}</span>}
          </div>
          {result.strengths && <p className="mt-2 text-sm"><span className="font-semibold text-moss">What earned marks: </span>{result.strengths}</p>}
          {result.improvements && <p className="mt-1 text-sm"><span className="font-semibold text-accent">To reach full marks: </span>{result.improvements}</p>}
          {result.model_answer && (
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer font-medium">Full-mark answer</summary>
              <p className="mt-2 whitespace-pre-wrap font-reading leading-relaxed text-ink-soft">{result.model_answer}</p>
            </details>
          )}
        </div>
      )}

      {showScheme && <Markscheme q={q} result={result} />}
    </li>
  );
}

function Markscheme({ q, result }: { q: ExamQuestion; result: MarkResult | null }) {
  const ms = q.markscheme;
  return (
    <div className="mt-3 rounded-2xl border border-dashed border-line px-4 py-3 text-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">Markscheme</p>
      {ms.type === "markbands" ? (
        <>
          <table className="mt-2 w-full text-left">
            <tbody>
              {ms.markbands.map((b, i) => (
                <tr key={i} className={`align-top ${result?.band === b.marks ? "bg-moss/10" : ""}`}>
                  <td className="w-16 py-1.5 pr-3 font-semibold">{b.marks}</td>
                  <td className="py-1.5">{b.descriptor}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {ms.indicative.length > 0 && (
            <>
              <p className="mt-3 text-xs font-semibold text-muted">Indicative content</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {ms.indicative.map((x, i) => <li key={i}>{x}</li>)}
              </ul>
            </>
          )}
        </>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {ms.points.map((pt, i) => {
            const r = result?.points.find((x) => x.index === i);
            return (
              <li key={i} className="flex items-start gap-2">
                <span
                  className={`mt-0.5 grid h-5 min-w-5 shrink-0 place-items-center rounded px-1 text-[11px] font-semibold ${
                    !r ? "bg-sunken text-muted" : r.awarded > 0 ? "bg-moss text-white" : "bg-danger-soft text-danger"
                  }`}
                >
                  {r ? (r.awarded > 0 ? `✓${r.awarded}` : "✗") : `[${pt.marks}]`}
                </span>
                <span>
                  {pt.text}
                  {r?.comment && <span className="block text-xs text-muted">{r.comment}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {ms.notes && <p className="mt-2 text-xs italic text-muted">{ms.notes}</p>}
    </div>
  );
}
