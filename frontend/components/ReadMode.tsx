"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, type Citation, type Source, type SourceDetail } from "@/lib/api";
import type { Anchor, Thread } from "@/lib/threads";
import type { Focus } from "./App";
import MarginThread from "./MarginThread";

type Props = {
  sources: Source[];
  source: Source | null;
  onPickSource: (id: number) => void;
  focus: Focus | null;
  threads: Thread[];
  activeThreadId: string | null;
  onActivate: (id: string | null) => void;
  onSelectText: (sourceId: number, anchor: Anchor) => void;
  onAsk: (t: Thread, message: string) => void;
  onDiscard: (id: string) => void;
  onCite: (c: Citation) => void;
  onGoLibrary: () => void;
};

type Range = { start: number; end: number; cls: string };

const detailCache = new Map<number, SourceDetail>();

export default function ReadMode(p: Props) {
  const [detail, setDetail] = useState<SourceDetail | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ start: number; end: number; nonce: number } | null>(null);
  const docRef = useRef<HTMLDivElement>(null);
  const { source, focus, threads } = p;

  // Load full text for the source being read. Only finished sources are cached: a big upload that
  // was opened while still processing has empty text, and caching that left Read mode blank.
  const ready = source?.status === "ready";
  useEffect(() => {
    if (!source || !ready) return setDetail(null);
    const cached = detailCache.get(source.id);
    if (cached && cached.char_count === source.char_count) return setDetail(cached);
    setDetail(null);
    setLoadErr(null);
    let live = true;
    api
      .source(source.id)
      .then((d) => {
        if (d.status === "ready" && d.text) detailCache.set(d.id, d);
        if (live) setDetail(d);
      })
      .catch((e) => live && setLoadErr((e as Error).message));
    return () => {
      live = false;
    };
  }, [source, ready]);

  // Jump to a cited passage once its source is on screen: highlight first, scroll once it's rendered.
  useEffect(() => {
    if (!focus || !detail || focus.sourceId !== detail.id) return;
    setFlash({ start: focus.start, end: focus.end, nonce: focus.nonce });
    const t = setTimeout(() => setFlash(null), 3200);
    return () => clearTimeout(t);
  }, [focus, detail]);

  useEffect(() => {
    if (!flash) return;
    const el = docRef.current?.querySelector<HTMLElement>("[data-hl-focus]") ?? findParagraph(docRef.current, flash.start);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [flash?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // Highlight ranges change only when anchors/active thread/flash change, not on every streamed token.
  const anchorSig = threads.map((t) => (t.anchor ? `${t.id}:${t.anchor.start}-${t.anchor.end}` : "")).join("|");
  const ranges = useMemo<Range[]>(() => {
    const r: Range[] = [];
    for (const t of threads)
      if (t.anchor) r.push({ ...t.anchor, cls: t.id === p.activeThreadId ? "hl-anchor-active" : "hl-anchor" });
    if (flash) r.push({ ...flash, cls: "hl-focus" });
    return r;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorSig, p.activeThreadId, flash]);

  const handleMouseUp = useCallback(() => {
    if (!detail) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const r = sel.getRangeAt(0);
    if (!docRef.current?.contains(r.commonAncestorContainer)) return;
    const a = absOffset(r.startContainer, r.startOffset);
    const b = absOffset(r.endContainer, r.endOffset);
    if (a == null || b == null) return;
    let [start, end] = a <= b ? [a, b] : [b, a];
    while (start < end && /\s/.test(detail.text[start])) start++;
    while (end > start && /\s/.test(detail.text[end - 1])) end--;
    if (end - start < 3) return;
    p.onSelectText(detail.id, { start, end, text: detail.text.slice(start, end) });
    sel.removeAllRanges();
  }, [detail, p]);

  if (p.sources.length === 0)
    return (
      <Empty>
        Your shelf is empty.{" "}
        <button className="text-accent underline underline-offset-4" onClick={p.onGoLibrary}>
          Add a source in the Library
        </button>{" "}
        to start reading.
      </Empty>
    );

  if (!source)
    return (
      <div className="mx-auto max-w-2xl px-6 pt-16">
        <p className="font-display text-3xl">What are we reading?</p>
        <ul className="mt-6 divide-y divide-line border-y border-line">
          {p.sources.map((s) => (
            <li key={s.id}>
              <button
                onClick={() => p.onPickSource(s.id)}
                className="flex w-full items-baseline justify-between gap-4 py-3 text-left hover:text-accent"
              >
                <span className="font-display text-lg">{s.title}</span>
                <span className="shrink-0 text-xs text-muted">{s.kind.toUpperCase()}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );

  const active = threads.find((t) => t.id === p.activeThreadId) ?? null;

  return (
    <div className="flex justify-center gap-12 px-4 pt-8 sm:px-14">
      <div className="w-full max-w-[68ch] shrink-0">
      <header className="mb-8">
        <select
          aria-label="Source"
          value={source.id}
          onChange={(e) => p.onPickSource(Number(e.target.value))}
          className="mb-2 max-w-full cursor-pointer appearance-none bg-transparent text-xs uppercase tracking-[0.18em] text-muted outline-none hover:text-ink"
        >
          {p.sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        <h1 className="font-display text-4xl leading-tight">{source.title}</h1>
        <p className="mt-2 text-sm text-muted">
          Select any passage to open a thread in the margin.
          {source.url && (
            <>
              {" · "}
              <a href={source.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                original
              </a>
            </>
          )}
        </p>
      </header>

      {loadErr && <p className="text-danger">{loadErr}</p>}
      {!ready ? (
        <p className="rounded-2xl border border-dashed border-line px-5 py-6 text-muted">
          {source.status === "failed"
            ? `This source couldn't be processed${source.error ? `: ${source.error}` : "."}`
            : `Still processing${source.stage ? ` (${source.stage}${source.progress != null ? `, ${Math.round(source.progress * 100)}%` : ""})` : ""}. It opens here as soon as it's ready.`}
        </p>
      ) : (
        !detail && !loadErr && <p className="animate-pulse text-muted">Opening…</p>
      )}

      {detail && (
        <div ref={docRef} onMouseUp={handleMouseUp} className="relative">
          <DocumentText text={detail.text} pages={detail.pages} ranges={ranges} />
        </div>
      )}
      </div>
      <MarginColumn
        threads={detail ? threads : []}
        docRef={docRef}
        activeThreadId={p.activeThreadId}
        onActivate={p.onActivate}
        onAsk={p.onAsk}
        onDiscard={p.onDiscard}
        onCite={p.onCite}
      />

      {/* Narrow screens: no margin, so the active thread floats above the command bar. */}
      {active && (
        <div className="fixed inset-x-3 bottom-28 z-30 max-h-[50vh] overflow-y-auto lg:hidden">
          <MarginThread
            thread={active}
            active
            onActivate={() => {}}
            onAsk={p.onAsk}
            onDiscard={p.onDiscard}
            onCite={p.onCite}
          />
        </div>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-xl px-6 pt-24 font-display text-2xl leading-snug">{children}</div>;
}

// ---------------- document rendering ----------------

type Para = { start: number; end: number; page?: number };

function splitParagraphs(text: string, pages: { page: number; start: number }[]): Para[] {
  const paras: Para[] = [];
  const re = /\n{2,}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) paras.push({ start: last, end: m.index });
    last = m.index + m[0].length;
  }
  if (last < text.length) paras.push({ start: last, end: text.length });
  // Mark the first paragraph of each page.
  let pi = 0;
  for (const para of paras) {
    while (pi < pages.length && pages[pi].start <= para.start) {
      if (para.page === undefined) para.page = pages[pi].page;
      pi++;
    }
  }
  return paras;
}

const DocumentText = memo(function DocumentText({
  text,
  pages,
  ranges,
}: {
  text: string;
  pages: { page: number; start: number }[];
  ranges: Range[];
}) {
  const paras = useMemo(() => splitParagraphs(text, pages), [text, pages]);
  return (
    <article className="reading font-reading text-[1.08rem] leading-[1.75] text-ink-soft">
      {paras.map((para) => (
        <div key={para.start} className="relative" data-p={para.start} data-p-end={para.end}>
          {para.page !== undefined && pages.length > 0 && (
            <span className="pointer-events-none absolute -left-14 top-1 hidden w-10 select-none text-right font-sans text-[11px] tracking-wide text-muted sm:block">
              p.{para.page}
            </span>
          )}
          <p className="mb-5 whitespace-pre-wrap">{renderSegments(text, para, ranges)}</p>
        </div>
      ))}
    </article>
  );
});

function renderSegments(text: string, para: Para, ranges: Range[]) {
  const local = ranges.filter((r) => r.start < para.end && r.end > para.start);
  const cuts = new Set([para.start, para.end]);
  for (const r of local) {
    cuts.add(Math.max(para.start, r.start));
    cuts.add(Math.min(para.end, r.end));
  }
  const points = [...cuts].sort((a, b) => a - b);
  const focus = local.find((r) => r.cls === "hl-focus");
  const focusStart = focus ? Math.max(focus.start, para.start) : -1;
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const s = points[i];
    const e = points[i + 1];
    if (e <= s) continue;
    const cls = local
      .filter((r) => r.start <= s && r.end >= e)
      .map((r) => r.cls)
      .join(" ");
    out.push(
      <span key={s} data-o={s} className={cls || undefined} data-hl-focus={s === focusStart ? "" : undefined}>
        {text.slice(s, e)}
      </span>,
    );
  }
  return out;
}

/** Map a DOM (node, offset) inside the document back to an absolute char offset in source.text. */
function absOffset(node: Node, offset: number): number | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const span = (node.parentElement as HTMLElement | null)?.closest<HTMLElement>("[data-o]");
    if (!span) return null;
    return Number(span.dataset.o) + offset;
  }
  const el = node as HTMLElement;
  // Element container: offset counts child nodes. Use the boundary child's start (or the end of the last).
  const child = el.childNodes[offset] as HTMLElement | undefined;
  const seg = child?.closest?.("[data-o]") ?? child?.querySelector?.("[data-o]");
  if (seg) return Number((seg as HTMLElement).dataset.o);
  const para = el.closest<HTMLElement>("[data-p]");
  if (para) return Number(offset === 0 ? para.dataset.p : para.dataset.pEnd);
  const spans = el.querySelectorAll<HTMLElement>("[data-o]");
  if (!spans.length) return null;
  if (offset === 0) return Number(spans[0].dataset.o);
  const last = spans[spans.length - 1];
  return Number(last.dataset.o) + (last.textContent?.length ?? 0);
}

function findParagraph(root: HTMLElement | null, offset: number): HTMLElement | null {
  if (!root) return null;
  for (const el of root.querySelectorAll<HTMLElement>("[data-p]")) {
    if (Number(el.dataset.p) <= offset && offset < Number(el.dataset.pEnd)) return el;
  }
  return null;
}

// ---------------- margin ----------------

function MarginColumn({
  threads,
  docRef,
  activeThreadId,
  onActivate,
  onAsk,
  onDiscard,
  onCite,
}: {
  threads: Thread[];
  docRef: React.RefObject<HTMLDivElement | null>;
  activeThreadId: string | null;
  onActivate: (id: string | null) => void;
  onAsk: (t: Thread, m: string) => void;
  onDiscard: (id: string) => void;
  onCite: (c: Citation) => void;
}) {
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const unanchoredY = useRef(new Map<string, number>());
  const [tops, setTops] = useState<Record<string, number>>({});
  const asideRef = useRef<HTMLElement>(null);

  // Place each card level with its anchor, then push cards down so none overlap.
  useLayoutEffect(() => {
    const doc = docRef.current;
    const aside = asideRef.current;
    if (!doc || !aside) return;
    const scroller = document.getElementById("mode-scroll");
    const baseTop = aside.getBoundingClientRect().top;
    const docTop = doc.getBoundingClientRect().top - baseTop;
    const desired = threads.map((t) => {
      let y: number;
      if (t.anchor) {
        const para = findParagraph(doc, t.anchor.start);
        const seg = para?.querySelector<HTMLElement>(`[data-o="${t.anchor.start}"]`);
        const el = seg ?? para;
        y = el ? el.getBoundingClientRect().top - baseTop : docTop;
      } else {
        if (!unanchoredY.current.has(t.id)) {
          const viewTop = scroller ? scroller.getBoundingClientRect().top : 0;
          unanchoredY.current.set(t.id, Math.max(docTop, viewTop - baseTop + 24));
        }
        y = unanchoredY.current.get(t.id)!;
      }
      return { id: t.id, y };
    });
    desired.sort((a, b) => a.y - b.y);
    const next: Record<string, number> = {};
    let floor = 0;
    for (const d of desired) {
      const top = Math.max(d.y, floor);
      next[d.id] = top;
      floor = top + (cardRefs.current.get(d.id)?.offsetHeight ?? 120) + 12;
    }
    setTops((prev) => {
      const same = Object.keys(next).length === Object.keys(prev).length && Object.entries(next).every(([k, v]) => prev[k] === v);
      return same ? prev : next;
    });
  });

  return (
    <aside ref={asideRef} aria-label="Margin threads" className="relative hidden w-[340px] shrink-0 lg:block">
      {threads.length === 0 && (
        <p className="sticky top-8 border-l-2 border-line pl-4 text-sm leading-relaxed text-muted">
          The margin is empty. Highlight a sentence you&apos;re unsure about, or use the bar below to ask about the whole
          source. Answers land here, pinned to the passage.
        </p>
      )}
      {threads.map((t) => (
        <div
          key={t.id}
          ref={(el) => {
            if (el) cardRefs.current.set(t.id, el);
            else cardRefs.current.delete(t.id);
          }}
          className={`absolute inset-x-0 transition-[top] duration-200 ${t.id === activeThreadId ? "z-20" : "z-10"}`}
          style={{ top: tops[t.id] ?? 0 }}
        >
          <MarginThread
            thread={t}
            active={t.id === activeThreadId}
            onActivate={() => onActivate(t.id)}
            onAsk={onAsk}
            onDiscard={onDiscard}
            onCite={onCite}
          />
        </div>
      ))}
    </aside>
  );
}
