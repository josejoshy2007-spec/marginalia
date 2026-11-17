"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { openPdf } from "@/lib/local/parse";

type PdfDoc = Awaited<ReturnType<typeof openPdf>>["doc"];

type Props = {
  blob: Blob;
  /** Number of pages the source was indexed with. */
  pageCount: number;
  /** Page to scroll to when the view opens. */
  initialPage: number;
  /** A citation was clicked: scroll to this page and outline it for a moment. */
  outline: { page: number; nonce: number } | null;
  /** Lets the parent ask which page is at the top of the screen (when switching views). */
  currentPageRef: { current: (() => number) | null };
};

const scroller = () => document.getElementById("mode-scroll");

/** The real PDF pages, drawn lazily as they scroll into view. */
export default function PdfPages({ blob, pageCount, initialPage, outline, currentPageRef }: Props) {
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ratios, setRatios] = useState<Record<number, number>>({});
  const [width, setWidth] = useState(0);
  const [lit, setLit] = useState<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const placed = useRef(false);

  useEffect(() => {
    let live = true;
    let task: { destroy: () => Promise<void> } | null = null;
    openPdf(blob)
      .then(({ doc: d, task: t }) => {
        task = t;
        if (!live) return void t.destroy();
        setDoc(d);
        return d.getPage(1).then((p) => {
          const v = p.getViewport({ scale: 1 });
          if (live) setRatios((r) => ({ 0: v.width / v.height, ...r }));
        });
      })
      .catch((e) => live && setErr((e as Error).message));
    return () => {
      live = false;
      void task?.destroy();
    };
  }, [blob]);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.round(el.clientWidth)));
    ro.observe(el);
    setWidth(Math.round(el.clientWidth));
    return () => ro.disconnect();
  }, []);

  const pageEl = (n: number) => boxRef.current?.querySelector<HTMLElement>(`[data-pdf-page="${n}"]`) ?? null;

  useEffect(() => {
    currentPageRef.current = () => {
      const top = (scroller()?.getBoundingClientRect().top ?? 0) + 96;
      let best = 1;
      for (let n = 1; n <= pageCount; n++) {
        const el = pageEl(n);
        if (!el) continue;
        if (el.getBoundingClientRect().top <= top) best = n;
        else break;
      }
      return best;
    };
    return () => {
      currentPageRef.current = null;
    };
  }); // eslint-disable-line react-hooks/exhaustive-deps

  // Open at the page the student was reading in the text view.
  useLayoutEffect(() => {
    if (!doc || !width || placed.current) return;
    placed.current = true;
    pageEl(Math.min(Math.max(outline?.page ?? initialPage, 1), pageCount))?.scrollIntoView({ block: "start" });
  }, [doc, width]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!outline || !doc || !width) return;
    setLit(outline.page);
    pageEl(outline.page)?.scrollIntoView({ behavior: "smooth", block: "start" });
    const t = setTimeout(() => setLit(null), 3200);
    return () => clearTimeout(t);
  }, [outline?.nonce, doc, width > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  if (err) return <p className="text-danger">{err}</p>;
  const ratio0 = ratios[0] ?? 0.707;
  return (
    <div ref={boxRef} className="space-y-4 bg-sunken p-2 sm:p-4" aria-label="PDF pages">
      {doc &&
        Array.from({ length: pageCount }, (_, i) => i + 1).map((n) => (
          <PdfPage
            key={n}
            doc={doc}
            n={n}
            width={width}
            ratio={ratios[n] ?? ratio0}
            lit={lit === n}
            onRatio={(r) => setRatios((all) => (Math.abs((all[n] ?? 0) - r) < 0.001 ? all : { ...all, [n]: r }))}
          />
        ))}
      {!doc && <p className="animate-pulse text-muted">Opening the PDF…</p>}
    </div>
  );
}

function PdfPage({
  doc,
  n,
  width,
  ratio,
  lit,
  onRatio,
}: {
  doc: PdfDoc;
  n: number;
  width: number;
  ratio: number;
  lit: boolean;
  onRatio: (r: number) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);

  // Draw only pages within ~1500px of the viewport; free the canvas of the rest.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { root: scroller(), rootMargin: "1500px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!near || !width) {
      if (c) {
        c.width = 0;
        c.height = 0;
      }
      return;
    }
    let cancelled = false;
    let task: { promise: Promise<unknown>; cancel: () => void } | null = null;
    (async () => {
      const page = await doc.getPage(n);
      if (cancelled || !c) return;
      const base = page.getViewport({ scale: 1 });
      onRatio(base.width / base.height);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cssW = wrap.current?.clientWidth || width;
      const scale = Math.min((cssW * dpr) / base.width, 2600 / base.width);
      const vp = page.getViewport({ scale });
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      task = page.render({ canvas: c, viewport: vp });
      await task.promise;
      page.cleanup();
    })().catch(() => {});
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [near, width, doc, n]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <div
        ref={wrap}
        data-pdf-page={n}
        style={{ aspectRatio: String(ratio) }}
        className={`relative mx-auto w-full max-w-[860px] border bg-card ${lit ? "border-accent outline outline-2 outline-accent" : "border-line"}`}
      >
        <canvas ref={canvas} className="absolute inset-0 h-full w-full" aria-label={`Page ${n}`} />
      </div>
      <p className="mt-1 text-center text-[11px] tracking-wide text-muted">p. {n}</p>
    </div>
  );
}
