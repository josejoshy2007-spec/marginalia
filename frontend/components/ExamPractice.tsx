"use client";

import { useEffect, useRef, useState } from "react";
import { tap } from "@/lib/native";
import { api, examQuestions, type ArtifactDetail, type ExamQuestion, type MarkResult } from "@/lib/api";
import { CiteMarks, ErrorNote, IBBadge, Segmented, scopeLabel, useArtifacts, Working, type StudyProps } from "./study/shared";
import { isReady, JobStatus } from "./study/shared";
import { TrashIcon } from "./icons";
import PhotoButton from "./PhotoButton";
import PracticeTimer from "./PracticeTimer";
import { MathText } from "./AnswerBody";
import { ExamText } from "./ExamText";
import { askConfirm } from "@/lib/confirm";
import {
  examPaper, examProfile, hasPaperChoice, parseIbLabel, sizeLabel, splitMarkLabel,
  type CodeLanguage, type ExamPaper, type ExamProfile,
} from "@/lib/local/ib";

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
  const [calculator, setCalculator] = useState<"allowed" | "none">("allowed");
  const profile = examProfile(parseIbLabel(p.ibLabel).course);
  const [style, setStyle] = useState<"sources" | "ib">("sources");
  // Courses with several paper styles pick a paper instead of a general "style"; the paper's rules are the style.
  const [paperId, setPaperId] = useState("");
  const paper = profile.papers ? (examPaper(profile, paperId) ?? profile.papers[0]) : undefined;
  const [language, setLanguage] = useState<CodeLanguage>("python");
  const paperStyle = p.ibLabel ? (paper ? "ib" : style) : "sources";
  const [custom, setCustom] = useState(false);

  return (
    <>
      <div className="mt-8 rounded border border-line bg-card p-5">
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
                {
                  source_ids: p.checkedIds, subtype: size, focus: focus || null,
                  extended: extended && (paper ? paper.allowsExtended : profile.allowsExtended), style: paperStyle,
                  ...(profile.calculator ? { calculator } : {}),
                  ...(paper ? { paper: paper.id, ...(paper.code ? { language } : {}) } : {}),
                },
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
                  { value: "short", label: sizeLabel("short", paper) },
                  { value: "section", label: sizeLabel("section", paper) },
                  { value: "paper", label: sizeLabel("paper", paper) },
                ]}
              />
              {hasPaperChoice(profile) && (
                <Segmented
                  label="Paper"
                  value={paper?.id ?? ""}
                  onChange={setPaperId}
                  options={(profile.papers ?? []).map((x) => ({ value: x.id, label: x.label }))}
                />
              )}
              {paper?.code && (
                <Segmented
                  label="Programming language"
                  value={language}
                  onChange={setLanguage}
                  options={[
                    { value: "python", label: "Python" },
                    { value: "java", label: "Java" },
                  ]}
                />
              )}
              {!paper && (
                <Segmented
                  label="Question style"
                  value={paperStyle}
                  onChange={setStyle}
                  options={[
                    { value: "sources", label: "From my sources" },
                    { value: "ib", label: "Like IB papers", disabled: !p.ibLabel },
                  ]}
                />
              )}
              {!paper && profile.allowsExtended && (
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input type="checkbox" checked={extended} onChange={(e) => setExtended(e.target.checked)} className="accent-[var(--accent)]" />
                  Extended response
                </label>
              )}
              {profile.calculator && (
                <Segmented
                  label="Calculator"
                  value={calculator}
                  onChange={setCalculator}
                  options={[
                    { value: "allowed", label: "Calculator: allowed" },
                    { value: "none", label: "Calculator: not allowed" },
                  ]}
                />
              )}
              <button className="btn-primary" disabled={!!busy || !p.checkedIds.length}>
                Make questions
              </button>
            </div>
            {!p.ibLabel && <p className="mt-2 text-sm text-muted">&quot;Like IB papers&quot; needs an IB course: set one in Library.</p>}
            {paperStyle === "ib" && (
              <p className="mt-2 text-sm text-muted">
                {paper
                  ? `Written like a ${p.ibLabel} ${paper.tag.replace(/ · /g, ", ")} question (best-effort: your subject guide is the authority). `
                  : `Written like a ${p.ibLabel} paper (command terms, mark splits, scenario stems). `}
                The content still comes only from your sources.
              </p>
            )}
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
                    {x.params.paper ? ` · ${profile.papers?.find((pp) => pp.id === x.params.paper)?.tag ?? ""}` : ""}
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
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const answerRef = useRef<HTMLTextAreaElement>(null);
  const profile = examProfile(parseIbLabel(p.ibLabel).course);
  // Default: no specific paper, so the typed marks and the course's general marking rules apply.
  const [paperId, setPaperId] = useState("none");
  const paper = examPaper(profile, paperId);
  const criteriaTotal = paper?.criteria?.reduce((n, c) => n + c.max, 0);
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
            question, marks: criteriaTotal ?? (Number(marks) || 1), answer, source_ids: p.checkedIds,
            ...(paper ? { paper: paper.id } : {}),
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
      {hasPaperChoice(profile) && (
        <Segmented
          label="Paper"
          value={paper?.id ?? "none"}
          onChange={setPaperId}
          options={[{ value: "none", label: "No specific paper" }, ...(profile.papers ?? []).map((x) => ({ value: x.id, label: x.label }))]}
        />
      )}
      {paper && <p className="text-xs text-muted">The markscheme and marking follow {paper.tag.replace(/ · /g, ", ")}.</p>}
      <div className="flex flex-wrap gap-2">
        <PhotoButton
          pasteScope={questionRef}
          label="Photo of the question"
          busyLabel="Reading the question…"
          onPhotos={async (files) => {
            const r = await api.photoQuestion(files);
            setQuestion(r.text);
            if (r.marks && !criteriaTotal) setMarks(String(r.marks));
          }}
        />
        <PhotoButton
          pasteScope={answerRef}
          label="Photo of my answer"
          onPhotos={async (files) => {
            const r = await api.photoAnswer(files, question || undefined);
            setAnswer((prev) => (prev.trim() ? `${prev.trimEnd()}\n${r.text}` : r.text));
          }}
        />
      </div>
      <div className="flex gap-3">
        <textarea ref={questionRef} value={question} onChange={(e) => setQuestion(e.target.value)} rows={3} placeholder="e.g. Explain why a binary search is faster than a linear search for large sorted arrays." className="field flex-1 resize-y" />
        <label className="flex w-24 shrink-0 flex-col gap-1 text-xs text-muted">
          Marks
          {criteriaTotal ? (
            <span className="field text-center text-lg text-muted" title="Set by the criteria">{criteriaTotal}</span>
          ) : (
            <input value={marks} onChange={(e) => setMarks(e.target.value.replace(/\D/g, "").slice(0, 2))} className="field text-center text-lg" inputMode="numeric" />
          )}
        </label>
      </div>
      <textarea ref={answerRef} value={answer} onChange={(e) => setAnswer(e.target.value)} rows={6} placeholder="Your answer (optional: leave blank to just see the markscheme)" className="field resize-y font-reading" />
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
  const profile = examProfile(parseIbLabel(p.ibLabel).course);
  const paper = examPaper(profile, questions[0]?.paper);
  const hasGloss = questions.some((q) => q.gloss);
  const [english, setEnglish] = useState(false);
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
      <div className="mt-3 flex justify-end">
        <PracticeTimer />
      </div>
      <h1 className="mt-2 font-display text-3xl leading-tight">{exam?.title ?? "…"}</h1>
      <p className="mt-1 text-sm text-muted">
        {paper
          ? paper.hint
          : profile.markingStyle === "maths"
            ? "Show your working line by line: marks are for method (M) and accuracy (A)."
            : "Answer in full sentences, using the command term."}{" "}
        The markscheme stays hidden until you submit.
      </p>
      {hasGloss && (
        <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" checked={english} onChange={(e) => setEnglish(e.target.checked)} className="accent-[var(--accent)]" />
          Show English
        </label>
      )}
      <ol className="mt-6 space-y-10 pb-10">
        {exam &&
          questions.map((q, i) => (
            <QuestionCard
              key={i}
              index={i}
              q={q}
              showStem={!!q.stem && q.stem !== questions[i - 1]?.stem}
              english={english}
              profile={profile}
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
  showStem,
  english,
  profile,
  exam,
  initial,
  onMarked,
  onCite,
}: {
  index: number;
  q: ExamQuestion;
  showStem: boolean;
  english: boolean;
  profile: ExamProfile;
  exam: ArtifactDetail;
  initial?: { answer: string; result: MarkResult | null };
  onMarked: (r: MarkResult) => void;
  onCite: StudyProps["onCite"];
}) {
  const [answer, setAnswer] = useState(initial?.answer ?? "");
  const answerRef = useRef<HTMLTextAreaElement>(null);
  const [result, setResult] = useState<MarkResult | null>(initial?.result ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showScheme, setShowScheme] = useState(!!initial?.result);
  const [photoNote, setPhotoNote] = useState<string | null>(null);
  const words = answer.trim() ? answer.trim().split(/\s+/).length : 0;
  const paper = examPaper(profile, q.paper);

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
      {showStem && q.stem && (
        <div className="mb-4 rounded border border-line bg-sunken px-4 py-3 text-sm">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">{paper?.stem?.label ?? "Text"}</p>
          <ExamText text={q.stem} className="mt-2 whitespace-pre-wrap font-reading leading-relaxed" />
        </div>
      )}
      <div className="flex items-start gap-3">
        <span className="mt-0.5 font-display text-xl text-muted">{index + 1}.</span>
        <div className="min-w-0 flex-1">
          <div className="font-medium leading-relaxed">
            <ExamText text={q.question} className="whitespace-pre-wrap" />
            <span className="whitespace-nowrap font-semibold">[{q.marks}]</span>
          </div>
          {english && q.gloss && <p className="mt-1 text-sm italic text-muted">{q.gloss}</p>}
          <p className="mt-1 text-xs text-muted">
            <span className="rounded bg-sunken px-1.5 py-0.5 font-semibold uppercase tracking-wider text-ink-soft">{q.command_term}</span>{" "}
            {tagLine(q, profile)}{" "}
            <CiteMarks cite={q.cite} passages={exam.passages} onCite={onCite} />
          </p>
        </div>
      </div>

      <textarea
        ref={answerRef}
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        rows={q.marks >= 15 ? 16 : q.marks >= 6 ? 10 : q.marks >= 3 ? 5 : 2}
        placeholder={paper?.code ? "Your code or trace table…" : "Your answer…"}
        spellCheck={!paper?.code}
        className={`field mt-3 w-full resize-y ${paper?.code ? "font-mono text-[13px] leading-snug" : "font-reading leading-relaxed"}`}
      />
      {photoNote && <p className="mt-2 text-xs text-accent">{photoNote}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button type="button" className="btn-primary" disabled={busy || !answer.trim()} onClick={mark}>
          {busy ? "Marking…" : result ? "Mark again" : "Mark my answer"}
        </button>
        <PhotoButton
          pasteScope={answerRef}
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
        <div className="mt-4 rounded border border-line bg-card p-4">
          <div className="flex items-baseline gap-3">
            <p className="font-display text-3xl">
              {result.marks_awarded}
              <span className="text-lg text-muted">/{result.max_marks}</span>
            </p>
            {result.band && <span className="text-sm text-muted">Markband {result.band}</span>}
          </div>
          {(result.criteria ?? []).length > 0 && (
            <ul className="mt-3 space-y-2 border-t border-line pt-3 text-sm">
              {(result.criteria ?? []).map((c) => (
                <li key={c.code}>
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    <span className="rounded bg-sunken px-1.5 py-0.5 text-[11px] font-semibold text-ink">{c.code}</span>
                    <span className="font-medium">{c.name}</span>
                    <span className="font-display text-lg">{c.awarded}<span className="text-sm text-muted">/{c.max}</span></span>
                    {c.band && <span className="text-xs text-muted">band {c.band}</span>}
                  </p>
                  {c.comment && <div className="mt-0.5 text-ink-soft"><ExamText text={c.comment} /></div>}
                  {c.next && <div className="mt-0.5 text-xs text-muted"><span className="font-semibold text-accent">Next band: </span><ExamText text={c.next} /></div>}
                </li>
              ))}
            </ul>
          )}
          {(result.mistakes ?? []).length > 0 && (
            <div className="mt-3 text-sm">
              <p className="font-semibold">Language mistakes</p>
              <ul className="mt-1 space-y-1">
                {(result.mistakes ?? []).map((m, i) => (
                  <li key={i}>
                    <span className="text-danger line-through">{m.text}</span> → <span className="font-medium text-moss">{m.correction}</span>
                    {m.note && <span className="block text-xs text-muted">{m.note}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.strengths && <p className="mt-2 text-sm"><span className="font-semibold text-moss">What earned marks: </span><ExamText text={result.strengths} /></p>}
          {result.improvements && <p className="mt-1 text-sm"><span className="font-semibold text-accent">To reach full marks: </span><ExamText text={result.improvements} /></p>}
          {result.model_answer && (
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer font-medium">Full-mark answer</summary>
              <ExamText text={result.model_answer} className="mt-2 whitespace-pre-wrap font-reading leading-relaxed text-ink-soft" />
            </details>
          )}
        </div>
      )}

      {showScheme && <Markscheme q={q} result={result} profile={profile} />}
    </li>
  );
}

/** "M1 (FT) set up the equation" -> a label chip and the text, for maths markschemes. */
function MarkLine({ text }: { text: string }) {
  const { label, rest } = splitMarkLabel(text);
  if (!label) return <MathText text={text} />;
  return (
    <>
      <span className="mr-1.5 rounded bg-sunken px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-ink">{label}</span>
      <MathText text={rest} />
    </>
  );
}

/** The line under a question: its paper (or objective / section), then how it is marked. */
function tagLine(q: ExamQuestion, profile: ExamProfile): string {
  const paper = examPaper(profile, q.paper);
  const how =
    q.markscheme.type === "criteria"
      ? "criterion-marked"
      : q.markscheme.type === "markbands"
        ? "markbands"
        : profile.markingStyle === "maths"
          ? "M/A marks"
          : paper?.code
            ? "marked per construct"
            : "point-marked";
  if (paper) return [paper.tag, how].join(" · ");
  const where = profile.objectiveLabels
    ? (OBJECTIVE[q.objective] ?? "")
    : profile.sectionLabels
      ? profile.sectionLabels[q.marks <= 7 ? 0 : 1]
      : "";
  return [where, how].filter(Boolean).join(" · ");
}

function Markscheme({ q, result, profile }: { q: ExamQuestion; result: MarkResult | null; profile: ExamProfile }) {
  const ms = q.markscheme;
  const maths = profile.markingStyle === "maths";
  return (
    <div className="mt-3 rounded border border-dashed border-line px-4 py-3 text-sm">
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Markscheme</p>
      {ms.type === "criteria" ? (
        <>
          {(ms.criteria ?? []).map((c) => {
            const r = result?.criteria?.find((x) => x.code === c.code);
            return (
              <div key={c.code} className="mt-2">
                <p className="font-semibold">
                  {c.code} · {c.name} <span className="font-normal text-muted">[{c.max}]</span>
                  {r && <span className="ml-2 text-moss">{r.awarded}/{r.max}</span>}
                </p>
                <table className="mt-1 w-full text-left">
                  <tbody>
                    {c.descriptors.map((d, i) => (
                      <tr key={i} className={`align-top ${r?.band && r.band === d.marks ? "bg-moss/10" : ""}`}>
                        <td className="w-16 py-1 pr-3 font-semibold">{d.marks}</td>
                        <td className="py-1"><ExamText text={d.descriptor} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
          {ms.indicative.length > 0 && (
            <>
              <p className="mt-3 text-xs font-semibold text-muted">Indicative content (possible, not required)</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {ms.indicative.map((x, i) => <li key={i}><ExamText text={x} /></li>)}
              </ul>
            </>
          )}
        </>
      ) : ms.type === "markbands" ? (
        <>
          <table className="mt-2 w-full text-left">
            <tbody>
              {ms.markbands.map((b, i) => (
                <tr key={i} className={`align-top ${result?.band === b.marks ? "bg-moss/10" : ""}`}>
                  <td className="w-16 py-1.5 pr-3 font-semibold">{b.marks}</td>
                  <td className="py-1.5"><ExamText text={b.descriptor} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {ms.indicative.length > 0 && (
            <>
              <p className="mt-3 text-xs font-semibold text-muted">Indicative content</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {ms.indicative.map((x, i) => <li key={i}><ExamText text={x} /></li>)}
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
                    !r ? "bg-sunken text-muted" : r.awarded > 0 ? "bg-moss text-on-accent" : "bg-danger-soft text-danger"
                  }`}
                >
                  {r ? (r.awarded > 0 ? `✓${r.awarded}` : "✗") : `[${pt.marks}]`}
                </span>
                <div className="min-w-0">
                  {maths ? <MarkLine text={pt.text} /> : <ExamText text={pt.text} />}
                  {r?.comment && <div className="text-xs text-muted"><ExamText text={r.comment} /></div>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {ms.notes && <div className="mt-2 text-xs italic text-muted"><ExamText text={ms.notes} /></div>}
    </div>
  );
}
