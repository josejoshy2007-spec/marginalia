"use client";

import { useEffect, useMemo, useState } from "react";
import { api, KIND_LABEL, type ArtifactDetail, type ArtifactSummary, type Citation, type Source } from "@/lib/api";
import { markersToTokens } from "@/lib/cite";
import AnswerBody from "./AnswerBody";
import { ErrorNote, IBBadge, ModeHeader, NoSources, RetryLink, Segmented, useArtifacts, type StudyProps } from "./study/shared";
import { TrashIcon } from "./icons";
import { askConfirm } from "@/lib/confirm";

type Format = "key_points" | "cornell" | "ib_revision" | "narrative";
type Length = "short" | "medium" | "long";

const FORMATS: { value: Format; label: string; blurb: string }[] = [
  { value: "key_points", label: "Key points", blurb: "Headings and tight bullets" },
  { value: "cornell", label: "Cornell notes", blurb: "Cue questions, notes, summary" },
  { value: "ib_revision", label: "IB revision notes", blurb: "Key terms, exam angles, pitfalls" },
  { value: "narrative", label: "Narrative", blurb: "Readable prose, like a chapter recap" },
];
const formatLabel = (v: string) => FORMATS.find((f) => f.value === v)?.label ?? v;

export default function SummariseMode(p: StudyProps) {
  const { items, error, setError, remove, refresh, retry } = useArtifacts(p.subjectId, "summary");
  const [openId, setOpenId] = useState<number | null>(null);

  if (openId != null) return <SummaryView id={openId} onCite={p.onCite} onExit={() => setOpenId(null)} />;

  return (
    <div className="mx-auto max-w-5xl px-6 pt-10 sm:px-10">
      <ModeHeader eyebrow="Summarise" title="Shrink it down">
        <IBBadge label={p.ibLabel} />
      </ModeHeader>
      {p.totalSources === 0 ? (
        <NoSources onGoLibrary={p.onGoLibrary} />
      ) : (
        <>
          <SummaryForm {...p} onMade={async (id) => { await refresh(); setOpenId(null); scrollToList(id); }} setError={setError} />
          {error && <ErrorNote text={error} onClose={() => setError(null)} />}
          <section className="mt-8" id="summary-list">
            {items === null ? (
              <p className="text-muted">Loading…</p>
            ) : items.length === 0 ? (
              <p className="text-muted">No summaries yet.</p>
            ) : (
              <ul className="divide-y divide-line border-y border-line">
                {items.map((s) => (
                  <SummaryRow key={s.id} s={s} onRetry={() => retry(s.id)} onOpen={() => setOpenId(s.id)} onDelete={() => askConfirm(`Delete “${s.title}”?`).then((ok) => { if (ok) void remove(s.id); })} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function scrollToList(id: number) {
  setTimeout(() => document.querySelector(`[data-summary="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 300);
}

function SummaryForm(
  p: StudyProps & { onMade: (id: number) => void; setError: (e: string | null) => void },
) {
  const ready = useMemo(() => (p.sources ?? []).filter((s) => s.status === "ready"), [p.sources]);
  const [picked, setPicked] = useState<number[]>(() => p.checkedIds);
  const [mode, setMode] = useState<"sources" | "paste">("sources");
  const [pageFrom, setPageFrom] = useState("");
  const [pageTo, setPageTo] = useState("");
  const [focus, setFocus] = useState("");
  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [format, setFormat] = useState<Format>(p.ibLabel ? "ib_revision" : "key_points");
  const [length, setLength] = useState<Length>("medium");
  const [busy, setBusy] = useState(false);

  useEffect(() => setPicked((cur) => cur.filter((id) => ready.some((s) => s.id === id))), [ready]);

  const pickedSources = ready.filter((s) => picked.includes(s.id));
  const onePdf = pickedSources.length === 1 && pickedSources[0].page_count > 0 ? pickedSources[0] : null;
  const pages = pickedSources.reduce((n, s) => n + (s.page_count || 0), 0);
  const big = pickedSources.reduce((n, s) => n + s.chunk_count, 0) > 75 && !focus.trim() && !(pageFrom || pageTo);

  const submit = async () => {
    setBusy(true);
    p.setError(null);
    try {
      let sourceIds = picked;
      if (mode === "paste") {
        const src = await api.addText(p.subjectId, pasteTitle.trim() || "Pasted for summary", pasteText);
        await p.onSourcesChanged?.();
        sourceIds = [src.id];
      }
      const made = await api.generate(p.subjectId, {
        kind: "summary",
        subtype: format,
        source_ids: sourceIds,
        focus: mode === "sources" ? focus.trim() || null : null,
        length,
        page_from: mode === "sources" && onePdf && pageFrom ? Number(pageFrom) : null,
        page_to: mode === "sources" && onePdf && pageTo ? Number(pageTo) : null,
      });
      setPasteText("");
      setPasteTitle("");
      p.onMade(made.id);
    } catch (e) {
      p.setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = mode === "paste" ? pasteText.trim().length > 40 : picked.length > 0;

  return (
    <form
      className="mt-8 rounded-2xl border border-line bg-card p-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit && !busy) submit();
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-display text-xl">What should I summarise?</p>
        <Segmented
          label="Input"
          value={mode}
          onChange={setMode}
          options={[
            { value: "sources", label: "From my sources" },
            { value: "paste", label: "Paste text" },
          ]}
        />
      </div>

      {mode === "sources" ? (
        <>
          <div className="mt-4 flex flex-wrap gap-2">
            {ready.map((s) => (
              <SourceChip
                key={s.id}
                s={s}
                on={picked.includes(s.id)}
                toggle={() => setPicked((cur) => (cur.includes(s.id) ? cur.filter((x) => x !== s.id) : [...cur, s.id]))}
              />
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {onePdf && (
              <span className="flex items-center gap-2 text-sm text-muted">
                Pages
                <input value={pageFrom} onChange={(e) => setPageFrom(e.target.value.replace(/\D/g, ""))} placeholder="1" className="field w-20 py-1.5" inputMode="numeric" />
                to
                <input value={pageTo} onChange={(e) => setPageTo(e.target.value.replace(/\D/g, ""))} placeholder={String(onePdf.page_count)} className="field w-20 py-1.5" inputMode="numeric" />
              </span>
            )}
            <input value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="Only about… (optional topic, e.g. TCP/IP)" className="field min-w-[220px] flex-1" />
          </div>
          {big && (
            <p className="mt-2 text-xs text-muted">
              That&apos;s a lot of material{pages ? ` (${pages} pages)` : ""}. I&apos;ll read it in parts and then combine
              them, which takes a few minutes. Tip: a page range or topic is quicker and more focused.
            </p>
          )}
        </>
      ) : (
        <div className="mt-4 grid gap-2">
          <input value={pasteTitle} onChange={(e) => setPasteTitle(e.target.value)} placeholder="Title (optional)" className="field" />
          <textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)} rows={6} placeholder="Paste an article, notes, a chapter…" className="field resize-y font-reading" />
          <p className="text-xs text-muted">It&apos;s saved to your Library too, so the summary&apos;s citations can open it.</p>
        </div>
      )}

      <div className="mt-5 grid gap-2 sm:grid-cols-4">
        {FORMATS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setFormat(f.value)}
            className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${format === f.value ? "border-ink bg-sunken" : "border-line hover:border-muted"}`}
          >
            <span className="block font-medium">{f.label}</span>
            <span className="block text-xs text-muted">{f.blurb}</span>
          </button>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Segmented
          label="Length"
          value={length}
          onChange={setLength}
          options={[
            { value: "short", label: "Brief" },
            { value: "medium", label: "Standard" },
            { value: "long", label: "Detailed" },
          ]}
        />
        <button className="btn-primary ml-auto" disabled={!canSubmit || busy}>
          {busy ? "Starting…" : "Summarise"}
        </button>
      </div>
    </form>
  );
}

function SourceChip({ s, on, toggle }: { s: Source; on: boolean; toggle: () => void }) {
  const kind = KIND_LABEL[s.kind];
  return (
    <button
      type="button"
      onClick={toggle}
      className={`flex max-w-full items-center gap-2 rounded-full border px-3 py-1 text-sm transition-colors ${on ? "border-ink bg-ink text-paper" : "border-line text-ink-soft hover:border-muted"}`}
    >
      <span className="truncate">{s.title}</span>
      <span className={`shrink-0 text-[10px] uppercase tracking-wider ${on ? "text-paper/70" : "text-muted"}`}>
        {kind}{s.page_count ? ` · ${s.page_count}p` : ""}
      </span>
    </button>
  );
}

function SummaryRow({
  s,
  onOpen,
  onDelete,
  onRetry,
}: {
  s: ArtifactSummary;
  onOpen: () => void;
  onDelete: () => void;
  onRetry: () => void;
}) {
  const scope = [
    s.params.page_from || s.params.page_to ? `pp. ${s.params.page_from ?? 1}–${s.params.page_to ?? "end"}` : null,
    s.params.focus ? `on “${s.params.focus}”` : null,
  ].filter(Boolean).join(" · ");
  return (
    <li data-summary={s.id} className="group flex items-center gap-4 py-3">
      <span className="w-28 shrink-0 text-xs uppercase tracking-wider text-muted">{formatLabel(s.subtype)}</span>
      <div className="min-w-0 flex-1">
        {s.status === "processing" ? (
          <>
            <p className="truncate font-display text-lg text-muted">{s.stage ?? "Starting"}…</p>
            <div className="mt-1 h-1 max-w-sm overflow-hidden rounded-full bg-sunken">
              <div className="h-full bg-accent transition-all duration-700" style={{ width: `${Math.max(4, (s.progress ?? 0) * 100)}%` }} />
            </div>
          </>
        ) : s.status === "failed" ? (
          <p className="flex flex-wrap items-center gap-3 text-sm text-danger">
            {s.error ?? "Failed."} <RetryLink onRetry={onRetry} />
          </p>
        ) : (
          <button type="button" onClick={onOpen} className="block max-w-full truncate text-left font-display text-lg group-hover:text-accent">
            {s.title}
          </button>
        )}
        {scope && <p className="text-xs text-muted">{scope}</p>}
      </div>
      <span className="text-xs text-muted">{new Date(s.created_at).toLocaleDateString()}</span>
      <button type="button" title="Delete" onClick={onDelete} className="text-muted opacity-0 hover:text-danger group-hover:opacity-100">
        <TrashIcon width={16} height={16} />
      </button>
    </li>
  );
}

function SummaryView({ id, onCite, onExit }: { id: number; onCite: (c: Citation) => void; onExit: () => void }) {
  const [s, setS] = useState<ArtifactDetail | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    api.artifact(id).then(setS);
  }, [id]);
  const body = s?.content.body ?? "";
  return (
    <div className="mx-auto max-w-3xl px-6 pt-8">
      <div className="flex items-center gap-3">
        <button type="button" onClick={onExit} className="btn-ghost">
          ← Summaries
        </button>
        {s && <span className="text-xs uppercase tracking-wider text-muted">{formatLabel(s.subtype)}</span>}
        {s && (
          <span className="ml-auto flex gap-3 text-sm text-muted">
            <button
              type="button"
              className="underline-offset-2 hover:underline"
              onClick={async () => {
                await navigator.clipboard.writeText(body.replace(/\s?\[\d+(?:\s*[,;]\s*\d+)*\]/g, ""));
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Copied" : "Copy text"}
            </button>
            <button type="button" className="underline-offset-2 hover:underline" onClick={() => window.print()}>
              Print
            </button>
          </span>
        )}
      </div>
      {!s ? (
        <p className="mt-6 text-muted">Opening…</p>
      ) : (
        <article className="mt-6">
          <h1 className="font-display text-4xl leading-tight">{s.title}</h1>
          <p className="mt-2 text-sm text-muted">
            From {new Set(s.passages.map((x) => x.source_id)).size} source(s), {s.passages.length} passages
            {s.content.parts && s.content.parts > 1 ? `, read in ${s.content.parts} parts` : ""}. Tap a number to see where a point came from.
          </p>
          <div className="mt-6 font-reading text-[1.04rem]">
            <AnswerBody body={markersToTokens(body, s.passages.length)} citations={s.passages} onCite={onCite} />
          </div>
        </article>
      )}
    </div>
  );
}
