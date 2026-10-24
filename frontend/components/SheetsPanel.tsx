"use client";

import { useEffect, useMemo, useState } from "react";
import { api, type ArtifactDetail, type Citation, type MapNode } from "@/lib/api";
import { markersToTokens } from "@/lib/cite";
import AnswerBody from "./AnswerBody";
import { CiteMarks, ErrorNote, scopeLabel, useArtifacts, Working, type StudyProps } from "./study/shared";
import { isReady, JobStatus } from "./study/shared";
import { TrashIcon } from "./icons";
import { askConfirm } from "@/lib/confirm";

const KINDS: { value: string; label: string; blurb: string }[] = [
  { value: "study_guide", label: "Study guide", blurb: "Key ideas in order + self-check" },
  { value: "briefing", label: "Briefing", blurb: "The one-page version" },
  { value: "faq", label: "FAQ", blurb: "Questions you'd actually ask" },
  { value: "timeline", label: "Timeline", blurb: "Events or stages in sequence" },
  { value: "key_terms", label: "Key terms", blurb: "Glossary with examples" },
  { value: "concept_map", label: "Concept map", blurb: "How the ideas branch" },
];

export const sheetLabel = (subtype: string) => KINDS.find((k) => k.value === subtype)?.label ?? subtype;

export default function SheetsPanel(p: StudyProps) {
  const { items, busy, notice, error, setError, generate, remove, retry, retryLast } = useArtifacts(p.subjectId, "sheet");
  const [focus, setFocus] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);

  if (openId != null) return <SheetView id={openId} onCite={p.onCite} onExit={() => setOpenId(null)} />;

  return (
    <section className="mt-8">
      <div className="rounded-2xl border border-line bg-card p-5">
        <p className="font-display text-xl">Make a study sheet</p>
        <p className="mt-1 text-sm text-muted">
          Written from {scopeLabel(p.checkedIds.length, p.totalSources)}, with every claim linked to its passage.
        </p>
        <input
          value={focus}
          onChange={(e) => setFocus(e.target.value)}
          placeholder="Focus on… (optional)"
          className="field mt-4 w-full"
        />
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {KINDS.map((k) => (
            <button
              key={k.value}
              type="button"
              disabled={!!busy || !p.checkedIds.length}
              onClick={async () => {
                const made = await generate(
                  { source_ids: p.checkedIds, subtype: k.value, focus: focus || null },
                  `${k.label}:`,
                  { openWhenReady: setOpenId },
                );
                if (made) setFocus("");
              }}
              className="rounded-xl border border-line px-3 py-2.5 text-left transition-colors hover:border-ink disabled:opacity-50"
            >
              <span className="block font-medium">{k.label}</span>
              <span className="block text-xs text-muted">{k.blurb}</span>
            </button>
          ))}
        </div>
        <Working label={busy} notice={notice} />
        {error && <ErrorNote text={error} onClose={() => setError(null)} onRetry={retryLast} />}
      </div>

      <div className="mt-8">
        {items === null ? (
          <p className="text-muted">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-muted">No sheets yet.</p>
        ) : (
          <ul className="divide-y divide-line border-y border-line">
            {items.map((s) => (
              <li key={s.id} className="group flex items-center gap-4 py-3">
                <span className="w-24 shrink-0 text-xs uppercase tracking-wider text-muted">{sheetLabel(s.subtype)}</span>
                <button type="button" onClick={() => isReady(s) && setOpenId(s.id)} className="min-w-0 flex-1 text-left">
                  <span className="block truncate font-display text-lg group-hover:text-accent">{s.title}</span>
                  <JobStatus a={s} onRetry={retry} />
                </button>
                <span className="text-xs text-muted">{new Date(s.created_at).toLocaleDateString()}</span>
                <button type="button" title="Delete sheet" onClick={() => askConfirm(`Delete “${s.title}”?`).then((ok) => { if (ok) void remove(s.id); })} className="text-muted opacity-0 hover:text-danger group-hover:opacity-100">
                  <TrashIcon width={16} height={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function SheetView({ id, onCite, onExit }: { id: number; onCite: (c: Citation) => void; onExit: () => void }) {
  const [sheet, setSheet] = useState<ArtifactDetail | null>(null);
  useEffect(() => {
    api.artifact(id).then(setSheet);
  }, [id]);

  return (
    <section className="mt-8">
      <div className="flex items-center gap-3">
        <button type="button" onClick={onExit} className="btn-ghost">
          ← Sheets
        </button>
        {sheet && (
          <>
            <span className="text-xs uppercase tracking-wider text-muted">{sheetLabel(sheet.subtype)}</span>
            <button type="button" className="ml-auto text-sm text-muted underline-offset-2 hover:underline" onClick={() => window.print()}>
              Print
            </button>
          </>
        )}
      </div>
      {!sheet ? (
        <p className="mt-6 text-muted">Opening…</p>
      ) : (
        <article className="mx-auto mt-6 max-w-[68ch]">
          <h1 className="font-display text-4xl leading-tight">{sheet.title}</h1>
          <div className="mt-6 font-reading text-[1.04rem]">
            {sheet.subtype === "concept_map" ? (
              <ConceptTree nodes={sheet.content.nodes ?? []} passages={sheet.passages} onCite={onCite} />
            ) : (
              <AnswerBody
                body={markersToTokens(sheet.content.body ?? "", sheet.passages.length)}
                citations={sheet.passages}
                onCite={onCite}
              />
            )}
          </div>
        </article>
      )}
    </section>
  );
}

function ConceptTree({ nodes, passages, onCite }: { nodes: MapNode[]; passages: Citation[]; onCite: (c: Citation) => void }) {
  const children = useMemo(() => {
    const m = new Map<string, MapNode[]>();
    for (const n of nodes) m.set(n.parent, [...(m.get(n.parent) ?? []), n]);
    return m;
  }, [nodes]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const render = (n: MapNode, depth: number) => {
    const kids = children.get(n.id) ?? [];
    const isOpen = !collapsed.has(n.id);
    return (
      <li key={n.id} className={depth ? "relative border-l border-line pl-5" : ""}>
        {depth > 0 && <span className="absolute left-0 top-[1.1rem] h-px w-4 bg-line" />}
        <div className="flex items-start gap-2 py-1.5">
          {kids.length ? (
            <button
              type="button"
              onClick={() => toggle(n.id)}
              className="mt-1 grid h-5 w-5 shrink-0 place-items-center rounded border border-line text-[10px] text-muted hover:text-ink"
              aria-label={isOpen ? "Collapse" : "Expand"}
            >
              {isOpen ? "−" : "+"}
            </button>
          ) : (
            <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" style={{ marginLeft: 6, marginRight: 6 }} />
          )}
          <div>
            <span className={depth === 0 ? "font-display text-2xl" : depth === 1 ? "font-sans font-semibold" : "font-sans"}>
              {n.label}
            </span>{" "}
            <CiteMarks cite={n.cite} passages={passages} onCite={onCite} />
            {n.note && <p className="text-sm leading-snug text-muted">{n.note}</p>}
          </div>
        </div>
        {kids.length > 0 && isOpen && <ul className="ml-2.5">{kids.map((k) => render(k, depth + 1))}</ul>}
      </li>
    );
  };

  const roots = children.get("") ?? [];
  return (
    <div>
      <div className="mb-3 flex gap-3 font-sans text-xs text-muted">
        <button type="button" className="underline-offset-2 hover:underline" onClick={() => setCollapsed(new Set())}>
          expand all
        </button>
        <button
          type="button"
          className="underline-offset-2 hover:underline"
          onClick={() => setCollapsed(new Set(nodes.filter((n) => n.parent && children.has(n.id)).map((n) => n.id)))}
        >
          collapse branches
        </button>
      </div>
      <ul>{roots.map((r) => render(r, 0))}</ul>
    </div>
  );
}
