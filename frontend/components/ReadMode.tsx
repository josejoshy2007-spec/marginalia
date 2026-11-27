"use client";

import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, pageLabel, PDF_PAGE_VIEW, type Citation, type PageReadStatus, type Source, type SourceDetail } from "@/lib/api";
import { narrowCitation } from "@/lib/cite-narrow";
import { buildSections, pageOfOffset, shouldHandleFocus, type Block } from "@/lib/reflow";
import type { Anchor, Thread } from "@/lib/threads";
import type { Focus } from "./App";
import AnswerBody from "./AnswerBody";
import MarginThread from "./MarginThread";
import OriginalView, { hasOriginalView } from "./OriginalView";
import PdfPages from "./PdfPages";
import { Segmented } from "./study/shared";
import { timestampAt } from "@/lib/original";

type Props = {
  sources: Source[];
  source: Source | null;
  onPickSource: (id: number) => void;
  focus: Focus | null;
  threads: Thread[];
  activeThreadId: string | null;
  onActivate: (id: string | null) => void;
  onSelectText: (sourceId: number, anchor: Anchor) => void;
  onAsk: (t: Thread, message: string, fresh?: boolean) => void;
  onDiscard: (id: string) => void;
  onCite: (c: Citation) => void;
  onGoLibrary: () => void;
};

type Range = { start: number; end: number; cls: string };

const detailCache = new Map<number, SourceDetail>();
/** Which view each PDF was last read in (kept while the app is open). */
const viewMemo = new Map<number, "text" | "page" | "original">();
/** Nonce of the last citation click acted on; `focus` in App is never cleared, so re-entering Read mode must not replay it. */
let handledFocusNonce = 0;

/** Where to seek for a citation: from the narrowed sentence (chunks overlap, so the chunk start can be minutes early). */
function seekSeconds(text: string, focus: { start: number; end: number; claim?: string | null }): number | null {
  const n = narrowCitation(text, focus.start, focus.end, focus.claim);
  return timestampAt(text, n.start);
}

export default function ReadMode(p: Props) {
  const [detail, setDetail] = useState<SourceDetail | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  // `start..end` is the cited chunk (outlined faintly); `ns..ne` the sentence the claim rests on (flashed strongly).
  const [flash, setFlash] = useState<{ start: number; end: number; ns: number; ne: number; narrowed: boolean; nonce: number } | null>(null);
  const docRef = useRef<HTMLDivElement>(null);
  const { source, focus, threads } = p;

  // Text (reflowed) or Page (the real PDF page). The reading position carries across by page number.
  const [view, setView] = useState<"text" | "page" | "original">("text");
  /** Focus nonce already handled when Original was opened: a seek must be newer, so opening it never replays an old citation. */
  const originalOpenNonce = useRef(0);
  const [pdf, setPdf] = useState<Blob | null | undefined>(undefined);
  const [attachErr, setAttachErr] = useState<string | null>(null);
  const [outline, setOutline] = useState<{ page: number; nonce: number } | null>(null);
  const [, setTick] = useState(0);
  const onReflow = useCallback(() => setTick((t) => t + 1), []);
  const pdfPageRef = useRef<(() => number) | null>(null);
  const startPage = useRef(1);
  const pendingTextPage = useRef<number | null>(null);
  const sourceId = source?.id;
  useEffect(() => {
    const v = sourceId != null ? (viewMemo.get(sourceId) ?? "text") : "text";
    if (v === "original") originalOpenNonce.current = handledFocusNonce; // restoring must not replay an old citation's seek
    setView(v);
    pendingTextPage.current = null;
    startPage.current = 1;
    setOutline(null);
  }, [sourceId]);
  const pageView = PDF_PAGE_VIEW && source?.kind === "pdf" && view === "page";
  const originalView = PDF_PAGE_VIEW && !!source && source.kind !== "pdf" && hasOriginalView(source) && view === "original";
  // A cited moment in a recording or video: the stamp that opens the cited text (or its paragraph).
  const seek = useMemo(() => {
    if (!focus || !detail || focus.sourceId !== detail.id) return null;
    const seconds = seekSeconds(detail.text, focus);
    return seconds == null ? null : { seconds, nonce: focus.nonce };
  }, [focus, detail]);
  const loadPdf = useCallback(() => {
    if (sourceId == null) return () => {};
    let live = true;
    setPdf(undefined);
    api.sourcePdf(sourceId).then((b) => live && setPdf(b)).catch(() => live && setPdf(null));
    return () => {
      live = false;
    };
  }, [sourceId]);
  useEffect(() => (pageView ? loadPdf() : undefined), [pageView, loadPdf]);

  // "Read this page with AI": is the original PDF on this device, how is a run going, which pages show the original text.
  const [hasPdf, setHasPdf] = useState(false);
  const [readStatus, setReadStatus] = useState<PageReadStatus | null>(null);
  const [readErr, setReadErr] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState<Set<number>>(() => new Set());
  useEffect(() => {
    setShowOriginal(new Set());
    setReadErr(null);
    setReadStatus(null);
  }, [sourceId]);
  useEffect(() => {
    setHasPdf(false);
    if (sourceId == null || source?.kind !== "pdf") return;
    let live = true;
    api.hasPdf(sourceId).then((v) => live && setHasPdf(v)).catch(() => {});
    api.pageReadStatus(sourceId).then((v) => live && setReadStatus(v)).catch(() => {});
    return () => {
      live = false;
    };
  }, [sourceId, source?.kind, pdf]);
  // Each finished page changes the text: fetch it again and keep the status current.
  useEffect(() => {
    if (sourceId == null || source?.kind !== "pdf") return;
    let live = true;
    const onRead = async (e: Event) => {
      if ((e as CustomEvent).detail?.sourceId !== sourceId) return;
      const [st, d] = await Promise.all([api.pageReadStatus(sourceId), api.source(sourceId).catch(() => null)]);
      if (!live) return;
      setReadStatus(st);
      if (d && d.status === "ready") {
        detailCache.set(d.id, d);
        setDetail(d);
      }
    };
    window.addEventListener("marginalia:page-read", onRead);
    return () => {
      live = false;
      window.removeEventListener("marginalia:page-read", onRead);
    };
  }, [sourceId, source?.kind]);
  const reading = readStatus?.state === "running";
  const startRead = useCallback(
    async (from: number, to: number, replace: boolean) => {
      if (sourceId == null) return;
      setReadErr(null);
      try {
        setReadStatus(await api.readPagesWithAI(sourceId, from, to, { replace }));
      } catch (e) {
        setReadErr((e as Error).message);
      }
    },
    [sourceId],
  );
  const retryRead = useCallback(async () => {
    if (sourceId == null) return;
    setReadErr(null);
    try {
      setReadStatus(await api.retryPageRead(sourceId));
    } catch (e) {
      setReadErr((e as Error).message);
    }
  }, [sourceId]);
  const toggleOriginal = useCallback(
    (page: number) =>
      setShowOriginal((cur) => {
        const next = new Set(cur);
        if (!next.delete(page)) next.add(page);
        return next;
      }),
    [],
  );

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
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (flashTimer.current && clearTimeout(flashTimer.current)), []);
  useEffect(() => {
    if (!focus || !detail || focus.sourceId !== detail.id) return;
    if (!shouldHandleFocus(focus.nonce, handledFocusNonce)) return;
    handledFocusNonce = focus.nonce;
    const toText = () => {
      if (!source) return;
      viewMemo.set(source.id, "text");
      setView("text");
    };
    // Original can only follow a citation by seeking audio/video; for anything else, or when there is no stamp at
    // the cited spot, show the cited text.
    if (view === "original" && source) {
      const seekable = source.kind === "audio" || source.kind === "video";
      if (!seekable || seekSeconds(detail.text, focus) == null) toText();
      else if (source.kind === "audio") {
        // A recording with no kept file on this device has nothing to seek in.
        api.sourceOriginal(source.id).then((o) => !o && toText()).catch(() => toText());
      }
    }
    // Narrow the cited chunk to the sentence the answer's claim rests on (the whole chunk if unsure).
    const n = narrowCitation(detail.text, focus.start, focus.end, focus.claim);
    setFlash({ start: focus.start, end: focus.end, ns: n.start, ne: n.end, narrowed: n.start !== focus.start || n.end !== focus.end, nonce: focus.nonce });
    const pg = pageOfOffset(detail.pages, detail.ai_pages, n.start);
    // A page that shows its AI reading hides the extracted text: show whichever one holds the citation.
    if (pg != null && detail.ai_pages?.some((a) => a.page === pg)) {
      const inAi = detail.ai_pages.some((a) => n.start >= a.start && n.start < a.end);
      setShowOriginal((cur) => {
        if (cur.has(pg) === !inAi) return cur;
        const next = new Set(cur);
        if (inAi) next.delete(pg);
        else next.add(pg);
        return next;
      });
    }
    if (pg != null) {
      startPage.current = pg; // Page view opens here even before any smooth scroll
      setOutline({ page: pg, nonce: focus.nonce });
    }
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 3200);
  }, [focus, detail]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!flash) return;
    const el = docRef.current?.querySelector<HTMLElement>("[data-hl-focus]") ?? findParagraph(docRef.current, flash.start);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [flash?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // Coming back from Page view: scroll the text to the page that was on screen.
  useLayoutEffect(() => {
    const n = pendingTextPage.current;
    if (view !== "text" || n == null || !detail || !docRef.current) return;
    pendingTextPage.current = null;
    const start = detail.pages.find((pg) => pg.page === n)?.start ?? 0;
    const sep = docRef.current.querySelector<HTMLElement>(`[data-page-sep="${n}"]`);
    const el = sep ?? [...docRef.current.querySelectorAll<HTMLElement>("[data-p]")].find((e) => Number(e.dataset.p) >= start);
    el?.scrollIntoView({ block: "start" });
  }, [view, detail]);

  const switchView = (v: "text" | "page" | "original") => {
    if (!source || !detail || v === view) return;
    if (v === "page") {
      // Page of the first block at the top of the screen.
      const top = (document.getElementById("mode-scroll")?.getBoundingClientRect().top ?? 0) + 96;
      let pg = 1;
      for (const el of docRef.current?.querySelectorAll<HTMLElement>("[data-pg]") ?? []) {
        if (el.getBoundingClientRect().top > top) break;
        pg = Number(el.dataset.pg);
      }
      startPage.current = pg;
    } else if (source.kind === "pdf") pendingTextPage.current = pdfPageRef.current?.() ?? startPage.current;
    viewMemo.set(source.id, v);
    if (v === "original") originalOpenNonce.current = handledFocusNonce;
    setOutline(null);
    setView(v);
  };

  // Highlight ranges change only when anchors/active thread/flash change, not on every streamed token.
  const anchorSig = threads.map((t) => (t.anchor ? `${t.id}:${t.anchor.start}-${t.anchor.end}` : "")).join("|");
  const ranges = useMemo<Range[]>(() => {
    const r: Range[] = [];
    for (const t of threads)
      if (t.anchor) r.push({ ...t.anchor, cls: t.id === p.activeThreadId ? "hl-anchor-active" : "hl-anchor" });
    if (flash) {
      if (flash.narrowed) r.push({ start: flash.start, end: flash.end, cls: "hl-chunk" });
      r.push({ start: flash.ns, end: flash.ne, cls: "hl-focus" });
    }
    return r;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorSig, p.activeThreadId, flash]);

  const handleMouseUp = useCallback(() => {
    if (!detail) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const r = sel.getRangeAt(0);
    if (!docRef.current?.contains(r.commonAncestorContainer)) return;
    let a = absOffset(r.startContainer, r.startOffset);
    let b = absOffset(r.endContainer, r.endOffset);
    // An AI reading is shown as rendered Markdown (no per-character offsets): anchor to the selected words when they
    // appear verbatim in the block's source text, else to the whole block(s).
    const blockOf = (n: Node) => ((n.nodeType === Node.TEXT_NODE ? n.parentElement : (n as HTMLElement))?.closest<HTMLElement>("[data-ai]") ?? null);
    const [ba, bb] = [blockOf(r.startContainer), blockOf(r.endContainer)];
    if (ba || bb) {
      const bs = ba ? Number(ba.dataset.p) : a;
      const be = bb ? Number(bb.dataset.pEnd) : b;
      if (bs == null || be == null) return;
      a = bs;
      b = be;
      const picked = sel.toString().trim();
      if (ba && ba === bb && picked.length >= 3) {
        const at = detail.text.slice(bs, be).indexOf(picked);
        if (at >= 0) [a, b] = [bs + at, bs + at + picked.length];
      }
    }
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
      <div className={`w-full shrink-0 ${pageView ? "max-w-[900px]" : "max-w-[66ch]"}`}>
      <header className="mb-8">
        <select
          aria-label="Source"
          value={source.id}
          onChange={(e) => p.onPickSource(Number(e.target.value))}
          className="mb-2 max-w-full cursor-pointer appearance-none bg-transparent text-[11px] uppercase tracking-[0.12em] text-muted outline-none hover:text-ink"
        >
          {p.sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        <h1 className="font-display text-4xl leading-tight">{source.title}</h1>
        {PDF_PAGE_VIEW && source.kind === "pdf" && detail && detail.pages.length > 0 && (
          <div className="mt-3">
            <Segmented
              label="View"
              value={view}
              onChange={switchView}
              options={[
                { value: "text", label: "Text" },
                { value: "page", label: "Page" },
              ]}
            />
          </div>
        )}
        {PDF_PAGE_VIEW && source.kind !== "pdf" && detail && hasOriginalView(source) && (
          <div className="mt-3">
            <Segmented
              label="View"
              value={view === "original" ? "original" : "text"}
              onChange={switchView}
              options={[
                { value: "text", label: "Text" },
                { value: "original", label: "Original" },
              ]}
            />
          </div>
        )}
        {source.kind === "pdf" && detail && (
          <PageReadPanel
            detail={detail}
            hasPdf={hasPdf}
            status={readStatus}
            error={readErr}
            onRead={(from, to) => startRead(from, to, false)}
            onRetry={retryRead}
          />
        )}
        <p className="mt-2 text-sm text-muted">
          {pageView ? "Showing the original pages. Switch to Text to select a passage and ask about it." : originalView ? "Showing the original. Switch to Text to select a passage and ask about it." : "Select any passage to open a thread in the margin."}
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

      {detail && originalView && <OriginalView key={source.id} source={source} seek={seek && seek.nonce > originalOpenNonce.current ? seek : null} />}
      {detail && !pageView && !originalView && (
        <div ref={docRef} onMouseUp={handleMouseUp} className="relative">
          <DocumentText
            text={detail.text}
            pages={detail.pages}
            aiPages={detail.ai_pages}
            ranges={ranges}
            label={pageLabel(detail.kind).short}
            onReflow={onReflow}
            canRead={hasPdf && detail.kind === "pdf"}
            reading={reading}
            showOriginal={showOriginal}
            onReadPage={(pg) => startRead(pg, pg, true)}
            onToggle={toggleOriginal}
          />
        </div>
      )}
      {detail && pageView && (
        <PageViewBody
          pdf={pdf}
          pageCount={detail.pages.length}
          initialPage={startPage.current}
          outline={outline}
          currentPageRef={pdfPageRef}
          pageAction={(n) => (
            <ReadPageButton
              exists={!!detail.ai_pages?.some((a) => a.page === n)}
              busy={reading}
              onRead={() => startRead(n, n, true)}
            />
          )}
          err={attachErr}
          onAttach={async (f) => {
            setAttachErr(null);
            try {
              await api.attachPdf(detail.id, f);
              loadPdf();
            } catch (e) {
              setAttachErr((e as Error).message);
            }
          }}
        />
      )}
      </div>
      {!pageView && !originalView && (
        <MarginColumn
          threads={detail ? threads : []}
          docRef={docRef}
          activeThreadId={p.activeThreadId}
          onActivate={p.onActivate}
          onAsk={p.onAsk}
          onDiscard={p.onDiscard}
          onCite={p.onCite}
        />
      )}

      {/* Narrow screens: no margin, so the active thread floats above the command bar. */}
      {active && (
        <div className="fixed inset-x-3 bottom-[calc(7rem+env(safe-area-inset-bottom))] z-30 max-h-[50vh] overflow-y-auto lg:hidden">
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

function PageViewBody({
  pdf,
  pageCount,
  initialPage,
  outline,
  currentPageRef,
  pageAction,
  err,
  onAttach,
}: {
  pdf: Blob | null | undefined;
  pageCount: number;
  initialPage: number;
  outline: { page: number; nonce: number } | null;
  currentPageRef: { current: (() => number) | null };
  pageAction: (n: number) => React.ReactNode;
  err: string | null;
  onAttach: (f: File) => void;
}) {
  if (pdf === undefined) return <p className="animate-pulse text-muted">Opening the pages…</p>;
  if (pdf === null)
    return (
      <div className="border border-dashed border-line px-5 py-6 text-muted">
        <p>
          This device doesn&apos;t have the original PDF (it was added before page view existed, or came from another
          device). Attach the same file to see the real pages. It stays on this device.
        </p>
        <label className="mt-4 inline-block cursor-pointer border border-line px-3 py-1.5 text-sm text-ink hover:border-accent">
          Attach the PDF
          <input
            type="file"
            accept="application/pdf,.pdf"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) onAttach(f);
            }}
          />
        </label>
        {err && <p className="mt-3 text-danger">{err}</p>}
      </div>
    );
  return <PdfPages blob={pdf} pageCount={pageCount} initialPage={initialPage} outline={outline} currentPageRef={currentPageRef} pageAction={pageAction} />;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-xl px-6 pt-24 font-display text-2xl leading-snug">{children}</div>;
}

// ---------------- document rendering ----------------
// Display only: blocks come from lib/reflow.ts and carry absolute offsets into the untouched source text,
// so selection, margin threads, citation flashes and highlights all keep working on `data-o` spans.

const NO_CITES: Citation[] = [];
const NOOP = () => {};

const DocumentText = memo(function DocumentText({
  text,
  pages,
  aiPages,
  ranges,
  label,
  onReflow,
  canRead,
  reading,
  showOriginal,
  onReadPage,
  onToggle,
}: {
  text: string;
  pages: { page: number; start: number; end?: number }[];
  aiPages?: { page: number; start: number; end: number }[];
  ranges: Range[];
  label: string;
  onReflow: () => void;
  canRead: boolean;
  reading: boolean;
  showOriginal: Set<number>;
  onReadPage: (page: number) => void;
  onToggle: (page: number) => void;
}) {
  const sections = useMemo(() => buildSections(text, pages, aiPages), [text, pages, aiPages]);
  const pageName = (n: number) => (label === "p." ? `p. ${n}` : `${label} ${n}`);
  const firstChanged = useRef(true);
  useEffect(() => {
    if (firstChanged.current) firstChanged.current = false;
    else onReflow(); // margin cards re-place themselves after a page switched between its AI reading and original text
  }, [showOriginal, aiPages]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <article className="reading font-reading text-[1.08rem] leading-[1.75] text-ink-soft">
      {sections.map((sec, si) => {
        const useAi = !!sec.ai && !showOriginal.has(sec.page!);
        const blank = !useAi && sec.original.length === 0;
        return (
          <Fragment key={sec.page ?? "all"}>
            {sec.page !== undefined && (
              <div
                data-page-sep={sec.page}
                data-pg={sec.page}
                className={`flex select-none flex-wrap items-center gap-x-3 gap-y-1 font-sans text-[11px] tracking-wide text-muted ${si === 0 ? "mb-4" : "mb-4 mt-9"}`}
              >
                <span aria-hidden className="h-px min-w-6 flex-1 bg-line" />
                <span>{pageName(sec.page)}</span>
                {sec.ai && (
                  <span className="inline-flex items-center gap-1">
                    <button
                      type="button"
                      aria-pressed={useAi}
                      onClick={() => onToggle(sec.page!)}
                      className="border border-line px-2 py-0.5 text-[11px] text-ink hover:border-accent"
                    >
                      {useAi ? "Show original text" : "Show AI reading"}
                    </button>
                  </span>
                )}
                {canRead && <ReadPageButton exists={!!sec.ai} busy={reading} onRead={() => onReadPage(sec.page!)} />}
                <span aria-hidden className="h-px min-w-6 flex-1 bg-line" />
              </div>
            )}
            {useAi && sec.page !== undefined && (
              <p data-pg={sec.page} className="mb-3 select-none font-sans text-[11px] text-muted">
                Read by AI. Check against the page.
              </p>
            )}
            {blank && sec.page !== undefined && (
              <p data-pg={sec.page} className="mb-5 font-sans text-xs italic text-muted">
                {canRead ? "No text on this page yet." : "No text on this page."}
              </p>
            )}
            {useAi
              ? sec.ai!.map((b) => <AiBlock key={b.start} text={text} block={b} ranges={ranges} page={sec.page!} />)
              : sec.original.map((b) =>
                  b.kind === "figure" ? (
                    <FigureBlock key={b.start} text={text} block={b} ranges={ranges} onReflow={onReflow} page={sec.page} />
                  ) : (
                    <div key={b.start} className="relative" data-p={b.start} data-p-end={b.end} data-pg={sec.page}>
                      {b.kind === "heading" ? (
                        <h3 className="mb-3 mt-6 font-display text-xl leading-snug text-ink">{renderSegments(text, b, ranges)}</h3>
                      ) : b.kind === "running" ? (
                        <p className="mb-2 font-sans text-xs text-muted">{renderSegments(text, b, ranges)}</p>
                      ) : (
                        <p className={b.kind === "item" ? "mb-3 pl-5" : "mb-5"}>{renderSegments(text, b, ranges)}</p>
                      )}
                    </div>
                  ),
                )}
          </Fragment>
        );
      })}
    </article>
  );
});

/** One Markdown chunk of an AI reading, rendered with maths and tables. It has no per-character offsets, so
 *  highlights tint the whole block; selecting inside it anchors to the block (see handleMouseUp). */
const AiBlock = memo(function AiBlock({ text, block, ranges, page }: { text: string; block: Block; ranges: Range[]; page: number }) {
  const hit = ranges.filter((r) => r.start < block.end && r.end > block.start);
  const cls = [...new Set(hit.map((r) => r.cls))].join(" ");
  const body = useMemo(() => text.slice(block.start, block.end), [text, block.start, block.end]);
  return (
    <div
      data-ai=""
      data-p={block.start}
      data-p-end={block.end}
      data-pg={page}
      data-hl-focus={hit.some((r) => r.cls === "hl-focus") ? "" : undefined}
      className={`relative mb-1 ${cls}`}
    >
      <AnswerBody body={body} citations={NO_CITES} onCite={NOOP} variant="chat" />
    </div>
  );
});

function ReadPageButton({ exists, busy, onRead }: { exists: boolean; busy: boolean; onRead: () => void }) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onRead}
      title="Sends this page to Gemini as an image to read its equations, tables and figures. Uses AI quota."
      className="border border-line px-2 py-0.5 text-[11px] text-ink hover:border-accent disabled:cursor-not-allowed disabled:opacity-50"
    >
      {exists ? "Read this page again with AI" : "Read this page with AI"}
    </button>
  );
}

/** The scanned-PDF note and the "Read pages with AI" range control, plus progress and Try again for a run. */
function PageReadPanel({
  detail,
  hasPdf,
  status,
  error,
  onRead,
  onRetry,
}: {
  detail: SourceDetail;
  hasPdf: boolean;
  status: PageReadStatus | null;
  error: string | null;
  onRead: (from: number, to: number) => void;
  onRetry: () => void;
}) {
  const n = detail.pages.length;
  const [from, setFrom] = useState("1");
  const [to, setTo] = useState(String(Math.min(n, 30)));
  const running = status?.state === "running";
  const clamp = (v: string) => Math.min(Math.max(1, Math.round(Number(v)) || 1), Math.max(1, n));
  const scanned = !!detail.no_text_layer;
  if (!scanned && !status && !error) return null;
  return (
    <div className="mt-3 space-y-2 border border-line bg-card px-3 py-2.5 text-sm" aria-label="Read pages with AI">
      {scanned && (
        <p className="text-muted">
          This PDF has no text layer. Read pages with AI to use them.
          {!hasPdf && " Attach the original file in Page view first."}
        </p>
      )}
      {scanned && hasPdf && n > 0 && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            let a = clamp(from);
            let b = clamp(to);
            if (a > b) [a, b] = [b, a];
            b = Math.min(b, a + 29);
            setFrom(String(a));
            setTo(String(b));
            onRead(a, b);
          }}
        >
          <label className="flex items-center gap-1.5 text-muted">
            Pages
            <input value={from} onChange={(e) => setFrom(e.target.value)} inputMode="numeric" className="field w-16" aria-label="First page" />
          </label>
          <label className="flex items-center gap-1.5 text-muted">
            to
            <input value={to} onChange={(e) => setTo(e.target.value)} inputMode="numeric" className="field w-16" aria-label="Last page" />
          </label>
          <button
            type="submit"
            disabled={running}
            className="bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Read pages with AI
          </button>
          <span className="text-xs text-muted">Up to 30 pages per run, one AI call each.</span>
        </form>
      )}
      {running && status && (
        <div role="status" className="space-y-1">
          <p className="animate-pulse text-muted">{status.stage}</p>
          <div className="h-1 bg-sunken" aria-hidden>
            <div className="h-1 bg-accent transition-[width]" style={{ width: `${Math.round((status.done / Math.max(1, status.total)) * 100)}%` }} />
          </div>
        </div>
      )}
      {status?.state === "failed" && (
        <p className="flex flex-wrap items-center gap-2 text-danger" role="alert">
          {status.error ?? "Reading stopped."}
          {status.pending.length > 0 && (
            <button type="button" onClick={onRetry} className="border border-danger px-2 py-0.5 text-xs hover:bg-danger-soft">
              Try again
            </button>
          )}
        </p>
      )}
      {status?.state === "done" && status.total > 0 && <p className="text-muted">Read {status.done} {status.done === 1 ? "page" : "pages"} with AI.</p>}
      {error && <p className="text-danger">{error}</p>}
    </div>
  );
}

/** Axis labels and other scraps from a figure: folded away until asked for. */
function FigureBlock({ text, block, ranges, onReflow, page }: { text: string; block: Block; ranges: Range[]; onReflow: () => void; page?: number }) {
  const hit = ranges.some((r) => r.start < block.end && r.end > block.start);
  const [open, setOpen] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (hit) setOpen(true); // a highlight or thread inside it must be visible
  }, [hit]);
  useEffect(() => {
    if (first.current) first.current = false;
    else onReflow(); // margin cards re-place themselves after the layout changed
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="mb-5" data-p={block.start} data-p-end={block.end} data-pg={page}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full select-none items-center justify-between gap-3 border border-dashed border-line px-3 py-1.5 text-left font-sans text-xs text-muted hover:text-ink"
      >
        <span>Text from a figure or graph</span>
        <span>{open ? "Hide" : `Show · ${block.lines} lines`}</span>
      </button>
      {open && (
        <p className="mt-1 whitespace-pre-wrap border-l-2 border-line pl-3 font-sans text-xs leading-relaxed text-muted">
          {renderSegments(text, block, ranges, true)}
        </p>
      )}
    </div>
  );
}

/** Split a block at highlight edges into spans carrying their absolute offset. Line breaks show as spaces
 *  (same length, so offsets stay exact) unless `keepBreaks`. */
function renderSegments(text: string, para: { start: number; end: number }, ranges: Range[], keepBreaks = false) {
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
    const piece = text.slice(s, e);
    out.push(
      <span key={s} data-o={s} className={cls || undefined} data-hl-focus={s === focusStart ? "" : undefined}>
        {keepBreaks ? piece : piece.replace(/\n/g, " ")}
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
  onAsk: (t: Thread, m: string, fresh?: boolean) => void;
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
