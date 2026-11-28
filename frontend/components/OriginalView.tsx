"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { api, type Source } from "@/lib/api";
import { saveFile } from "@/lib/native";
import { youtubeEmbedUrl, youtubeId } from "@/lib/original";
import { MAX_ZIP, viewCsv, viewDocx, viewPptx, viewXlsx, type Box, type ChartData, type DocBlock, type Img, type Para, type Sheet, type Slide } from "@/lib/office-view";

type Orig = { blob: Blob; name: string };

/** Kinds whose original is a file kept on this device. */
export const FILE_KINDS: Source["kind"][] = ["image", "audio", "slides", "doc", "sheet"];

/** Does this source have an "Original" view at all? (PDFs use Page view; pasted text has no original.) */
export function hasOriginalView(s: Source): boolean {
  if (s.kind === "url") return !!s.url;
  if (s.kind === "video") return !!s.url;
  return FILE_KINDS.includes(s.kind);
}

const btn = "inline-block cursor-pointer border border-line px-3 py-1.5 text-sm text-ink hover:border-accent";

export default function OriginalView({ source, seek }: { source: Source; seek: { seconds: number; nonce: number } | null }) {
  const isFile = FILE_KINDS.includes(source.kind);
  const [orig, setOrig] = useState<Orig | null | undefined>(isFile ? undefined : null);
  const [err, setErr] = useState<string | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const media = useRef<HTMLAudioElement>(null);

  const load = useCallback(() => {
    if (!isFile) return () => {};
    let live = true;
    setOrig(undefined);
    api.sourceOriginal(source.id).then((o) => live && setOrig(o)).catch(() => live && setOrig(null));
    return () => {
      live = false;
    };
  }, [source.id, isFile]);
  useEffect(() => load(), [load]);

  // Object URL for the kept file, released when it changes or the view closes.
  useEffect(() => {
    if (!orig || unsafeImage(orig)) return setSrc(null);
    const u = URL.createObjectURL(orig.blob);
    setSrc(u);
    return () => URL.revokeObjectURL(u);
  }, [orig]);

  // Seek the recording to a cited timestamp.
  useEffect(() => {
    const el = media.current;
    if (!seek || !el || !src) return;
    const go = () => {
      el.currentTime = seek.seconds;
    };
    if (el.readyState >= 1) go();
    else el.addEventListener("loadedmetadata", go, { once: true });
    return () => el.removeEventListener("loadedmetadata", go);
  }, [seek?.nonce, src]); // eslint-disable-line react-hooks/exhaustive-deps

  if (source.kind === "video") {
    const id = youtubeId(source.url);
    if (!id) return <LinkOut url={source.url} label="Open the video" />;
    return (
      <div className="aspect-video w-full border border-line bg-sunken">
        <iframe
          key={`${id}:${seek?.nonce ?? 0}`}
          title={source.title}
          src={youtubeEmbedUrl(id, seek?.seconds)}
          className="h-full w-full"
          allow="encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>
    );
  }
  if (source.kind === "url") return <LinkOut url={source.url} label="Open the page" />;

  if (orig === undefined) return <p className="animate-pulse text-muted">Opening the original…</p>;
  if (orig === null)
    return (
      <div className="border border-dashed border-line px-5 py-6 text-muted">
        <p>The original file is on the device you added it from. To see it here, attach the same file. It stays on this device.</p>
        <label className={`mt-4 ${btn}`}>
          Attach the file
          <input
            type="file"
            accept={source.kind === "image" ? "image/*" : source.kind === "audio" ? "audio/*,video/*" : undefined}
            className="sr-only"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              setErr(null);
              try {
                await api.attachOriginal(source.id, f);
                load();
              } catch (x) {
                setErr((x as Error).message);
              }
            }}
          />
        </label>
        {err && <p className="mt-3 text-sm text-danger">{err}</p>}
      </div>
    );

  if (source.kind === "image" && unsafeImage(orig))
    return (
      <div>
        <p className="text-muted">This image type can&apos;t be shown safely here.</p>
        <div className="mt-4">
          <button className={btn} onClick={() => saveFile(orig.blob, orig.name).catch((x) => setErr((x as Error).message))}>
            Open original file
          </button>
        </div>
        {err && <p className="mt-3 text-sm text-danger">{err}</p>}
      </div>
    );
  if (source.kind === "image")
    return src ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt={source.title} className="block h-auto w-full max-w-full border border-line" />
    ) : null;

  if (source.kind === "audio")
    return (
      <div>
        <audio ref={media} src={src ?? undefined} controls preload="metadata" className="w-full" />
        <p className="mt-2 text-sm text-muted">Click a citation to jump to that moment in the recording.</p>
      </div>
    );

  return (
    <div>
      <OfficeBody source={source} orig={orig} />
      <div className="mt-4">
        <button className={btn} onClick={() => saveFile(orig.blob, orig.name).catch((x) => setErr((x as Error).message))}>
          Open original file
        </button>
      </div>
      {err && <p className="mt-3 text-sm text-danger">{err}</p>}
    </div>
  );
}

/** SVG can carry scripts, so it is never previewed inline. */
const unsafeImage = (o: Orig) => o.blob.type === "image/svg+xml" || /\.svg$/i.test(o.name);

type Parsed =
  | { kind: "slides"; slides: Slide[] }
  | { kind: "sheets"; sheets: Sheet[] }
  | { kind: "doc"; blocks: DocBlock[] }
  | "too-large"
  | null;

async function parseOffice(source: Source, orig: Orig): Promise<Parsed> {
  const ext = orig.name.split(".").pop()?.toLowerCase() ?? "";
  if (source.kind === "sheet" && (ext === "csv" || ext === "tsv")) return { kind: "sheets", sheets: viewCsv(await (orig.blob.size > 20e6 ? orig.blob.slice(0, 20e6) : orig.blob).text()) };
  if (orig.blob.size > MAX_ZIP) return "too-large"; // don't load a huge file into memory just to refuse it
  const bytes = new Uint8Array(await orig.blob.arrayBuffer());
  if (source.kind === "slides" && ext === "pptx") {
    const slides = viewPptx(bytes);
    return slides && { kind: "slides", slides };
  }
  if (source.kind === "sheet" && (ext === "xlsx" || ext === "xlsm")) {
    const sheets = viewXlsx(bytes);
    return sheets && { kind: "sheets", sheets };
  }
  if (source.kind === "doc" && ext === "docx") {
    const blocks = viewDocx(bytes);
    return blocks && { kind: "doc", blocks };
  }
  return null;
}

/** Object URLs for images, released on unmount. */
function useImageUrls(imgs: Img[]): string[] {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    const made = imgs.map((i) => URL.createObjectURL(new Blob([i.data as BlobPart], { type: i.mime })));
    setUrls(made);
    return () => made.forEach((u) => URL.revokeObjectURL(u));
  }, [imgs]);
  return urls;
}

function OfficeBody({ source, orig }: { source: Source; orig: Orig }) {
  const [parsed, setParsed] = useState<Parsed | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setParsed(undefined);
    parseOffice(source, orig)
      .then((p) => live && setParsed(p))
      .catch(() => live && setParsed(null));
    return () => {
      live = false;
    };
  }, [source.kind, orig]); // eslint-disable-line react-hooks/exhaustive-deps
  if (parsed === undefined) return <p className="animate-pulse text-muted">Opening the original…</p>;
  if (parsed === "too-large")
    return <p className="border border-line px-5 py-6 text-muted">This file is too large to show here. The Text view shows its content, and you can open the original file in another app.</p>;
  if (!parsed)
    return (
      <p className="border border-line px-5 py-6 text-muted">
        This file can&apos;t be shown here with its original layout. The Text view shows its content, and you can open the
        original file in another app.
      </p>
    );
  if (parsed.kind === "slides") return <Slides slides={parsed.slides} />;
  if (parsed.kind === "sheets") return <Sheets sheets={parsed.sheets} />;
  return <WordDoc blocks={parsed.blocks} />;
}

/** Images a slide needs a URL for: the rebuilt pictures, or the old stacked list when the rebuild failed. */
const slideImgs = (s: Slide): Img[] => (s.els ? s.els.flatMap((e) => (e.t === "img" ? [e.img] : [])) : s.images);

function Slides({ slides }: { slides: Slide[] }) {
  const all = useMemo(() => slides.flatMap(slideImgs), [slides]);
  const urls = useImageUrls(all);
  const urlOf = useMemo(() => new Map(all.map((img, i) => [img, urls[i]] as const)), [all, urls]);
  return (
    <div className="space-y-4">
      {slides.map((s) => (
        <section key={s.n} className="border border-line bg-card p-3">
          <p className="text-xs text-muted">Slide {s.n}</p>
          <div className="mt-2">{s.els ? <SlideCanvas slide={s} urlOf={urlOf} /> : <StackedSlide slide={s} urlOf={urlOf} />}</div>
        </section>
      ))}
    </div>
  );
}

/** Old text-only view, kept for a slide the positioned rebuild could not read. */
function StackedSlide({ slide: s, urlOf }: { slide: Slide; urlOf: Map<Img, string> }) {
  return (
    <div className="flex aspect-video w-full flex-col overflow-auto border border-line bg-sunken p-4">
      {s.title && <h3 className="font-display text-lg text-ink">{s.title}</h3>}
      {s.paras.map((t, i) => (
        <p key={i} className="mt-2 whitespace-pre-line text-sm text-ink">
          {t}
        </p>
      ))}
      {s.images.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {s.images.map((img, i) => {
            const u = urlOf.get(img);
            // eslint-disable-next-line @next/next/no-img-element
            return u ? <img key={i} src={u} alt="" className="h-auto max-h-40 max-w-full border border-line" /> : null;
          })}
        </div>
      )}
    </div>
  );
}

const isDark = (hexColour: string | undefined) => {
  if (!hexColour || !/^#[0-9a-f]{6}$/i.test(hexColour)) return false;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hexColour.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
};

/** A slide rebuilt from its shapes. Real slide colours are the content, so they are inline; the frame stays themed. */
function SlideCanvas({ slide: s, urlOf }: { slide: Slide; urlOf: Map<Img, string> }) {
  const wPt = s.w / 12700;
  const cq = (pt: number) => `${((pt / wPt) * 100).toFixed(3)}cqw`;
  const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
  const pos = (e: Box): CSSProperties => ({ position: "absolute", left: pct(e.x), top: pct(e.y), width: pct(e.w), height: pct(e.h), overflow: "hidden" });
  // Default text colour follows what the text sits on: its own fill when it has a solid one, else the slide background.
  const inkOn = (fill?: string) => (isDark(fill && fill.startsWith("#") ? fill : (s.bgBase ?? s.bg)) ? "#ffffff" : "#1a1a1a");
  const ink = inkOn();
  const paras = (ps: Para[]) =>
    ps.map((p, i) => (
      <p
        key={i}
        style={{
          margin: 0,
          marginTop: i ? cq(p.size * 0.25) : 0,
          textAlign: p.algn === "just" ? "justify" : p.algn === "ctr" ? "center" : p.algn === "r" ? "right" : "left",
          paddingLeft: p.bullet ? cq(p.size * (p.lvl * 1.1 + 1)) : cq(p.size * p.lvl * 1.1),
          textIndent: p.bullet ? cq(-p.size) : undefined,
          fontSize: cq(p.size),
          lineHeight: 1.15,
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {p.bullet ? "• " : null}
        {p.runs.length ? (
          p.runs.map((r, j) => (
            <span
              key={j}
              style={{
                fontSize: r.size === p.size ? undefined : cq(r.size),
                fontWeight: r.b ? 700 : undefined,
                fontStyle: r.i ? "italic" : undefined,
                textDecoration: r.u ? "underline" : undefined,
                color: r.color,
              }}
            >
              {r.text}
            </span>
          ))
        ) : (
          <>&nbsp;</>
        )}
      </p>
    ));
  return (
    <div
      className="relative w-full overflow-hidden border border-line"
      style={{ aspectRatio: `${s.w} / ${s.h}`, background: s.bg ?? "#ffffff", color: ink, containerType: "inline-size" } as CSSProperties}
    >
      {s.els!.map((e, i) => {
        if (e.t === "img") {
          const u = urlOf.get(e.img);
          // eslint-disable-next-line @next/next/no-img-element
          return u ? <img key={i} src={u} alt="" style={{ ...pos(e), objectFit: "fill" }} /> : null;
        }
        if (e.t === "text")
          return (
            <div
              key={i}
              style={{
                ...pos(e),
                display: "flex",
                flexDirection: "column",
                justifyContent: e.anchor === "ctr" ? "center" : e.anchor === "b" ? "flex-end" : "flex-start",
                padding: `${cq(3.6)} ${cq(7.2)}`,
                boxSizing: "border-box",
                background: e.fill,
                color: inkOn(e.fill),
                border: e.line ? `${cq(e.lineW ?? 1)} solid ${e.line}` : undefined,
              }}
            >
              <div>{paras(e.paras)}</div>
            </div>
          );
        if (e.t === "table")
          return (
            <div key={i} style={pos(e)}>
              <table style={{ width: "100%", height: "100%", tableLayout: "fixed", borderCollapse: "collapse" }}>
                <colgroup>
                  {e.cols.map((c, ci) => (
                    <col key={ci} style={{ width: pct(c) }} />
                  ))}
                </colgroup>
                <tbody>
                  {e.rows.map((r, ri) => (
                    <tr key={ri} style={{ height: pct(r.h) }}>
                      {r.cells.map((c, ci) => (
                        <td
                          key={ci}
                          colSpan={c.colSpan}
                          rowSpan={c.rowSpan}
                          style={{
                            border: "1px solid rgba(128,128,128,0.55)",
                            padding: `${cq(2)} ${cq(5)}`,
                            verticalAlign: "middle",
                            overflow: "hidden",
                            background: c.fill ?? (c.header ? "rgba(128,128,128,0.25)" : undefined),
                            fontWeight: c.header ? 700 : undefined,
                            color: inkOn(c.fill),
                          }}
                        >
                          {paras(c.paras)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        return (
          <div key={i} style={pos(e)}>
            <ChartView chart={e.chart} />
          </div>
        );
      })}
    </div>
  );
}

const PALETTE = ["#4472c4", "#ed7d31", "#a5a5a5", "#ffc000", "#5b9bd5", "#70ad47", "#9e480e", "#997300"];
const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toLocaleString("en", { maximumFractionDigits: 0 }) : String(Math.round(v * 100) / 100));

/** Bar, column, line and pie drawn from the parsed numbers (never from file SVG). Other charts show their data. */
function ChartView({ chart }: { chart: ChartData }) {
  const { kind, series, cats, title } = chart;
  const W = 400;
  const H = 260;
  const col = (i: number) => series[i]?.color ?? PALETTE[i % PALETTE.length];
  const n = Math.max(cats.length, ...series.map((s) => s.vals.length), 1);
  const label = (i: number) => (cats[i] ?? String(i + 1)).slice(0, 14);
  const body = (() => {
    if (kind === "table")
      return (
        <foreignObject x={0} y={0} width={W} height={H}>
          <div style={{ fontSize: 11, overflow: "hidden", height: H }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <tbody>
                <tr>
                  <th />
                  {series.map((s, i) => (
                    <th key={i} style={{ border: "1px solid rgba(128,128,128,0.5)", padding: 2 }}>
                      {s.name}
                    </th>
                  ))}
                </tr>
                {Array.from({ length: n }, (_, r) => (
                  <tr key={r}>
                    <td style={{ border: "1px solid rgba(128,128,128,0.5)", padding: 2 }}>{label(r)}</td>
                    {series.map((s, i) => (
                      <td key={i} style={{ border: "1px solid rgba(128,128,128,0.5)", padding: 2, textAlign: "right" }}>
                        {s.vals[r] !== undefined ? fmt(s.vals[r]) : ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </foreignObject>
      );
    if (kind === "pie") {
      const vals = (series[0]?.vals ?? []).map((v) => Math.max(0, v));
      const sum = vals.reduce((a, b) => a + b, 0) || 1;
      const R = 80;
      let a0 = -Math.PI / 2;
      return (
        <>
          {vals.map((v, i) => {
            const a1 = a0 + (v / sum) * Math.PI * 2;
            const [x0, y0, x1, y1] = [Math.cos(a0), Math.sin(a0), Math.cos(a1), Math.sin(a1)];
            const d = v / sum >= 0.9999 ? `M ${W / 3 - R} ${H / 2} a ${R} ${R} 0 1 0 ${2 * R} 0 a ${R} ${R} 0 1 0 ${-2 * R} 0` : `M ${W / 3} ${H / 2} L ${W / 3 + R * x0} ${H / 2 + R * y0} A ${R} ${R} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${W / 3 + R * x1} ${H / 2 + R * y1} Z`;
            a0 = a1;
            return <path key={i} d={d} fill={PALETTE[i % PALETTE.length]} stroke="rgba(255,255,255,0.7)" strokeWidth={1} />;
          })}
          {vals.slice(0, 10).map((v, i) => (
            <g key={i}>
              <rect x={W * 0.62} y={30 + i * 20} width={10} height={10} fill={PALETTE[i % PALETTE.length]} />
              <text x={W * 0.62 + 16} y={39 + i * 20} fontSize={11} fill="currentColor">
                {label(i)} ({Math.round((v / sum) * 100)}%)
              </text>
            </g>
          ))}
        </>
      );
    }
    const all = series.flatMap((s) => s.vals);
    const max = Math.max(0, ...all) || 1;
    const min = Math.min(0, ...all);
    const horizontal = kind === "bar";
    const [L, T, Rr, B] = horizontal ? [70, 8, 10, 28] : [36, 8, 10, 52];
    const pw = W - L - Rr;
    const ph = H - T - B;
    const span = max - min || 1;
    const val = (v: number) => (horizontal ? L + ((v - min) / span) * pw : T + ph - ((v - min) / span) * ph);
    const zero = val(0);
    const bandSize = (horizontal ? ph : pw) / n;
    const barW = (bandSize * 0.8) / series.length;
    return (
      <>
        <line x1={L} y1={T} x2={L} y2={T + ph} stroke="currentColor" strokeOpacity={0.4} />
        <line x1={L} y1={horizontal ? T + ph : zero} x2={L + pw} y2={horizontal ? T + ph : zero} stroke="currentColor" strokeOpacity={0.4} />
        {[min, (min + max) / 2, max].map((t, i) => (
          <text key={i} x={horizontal ? val(t) : L - 4} y={horizontal ? T + ph + 12 : val(t) + 3} fontSize={9} textAnchor={horizontal ? "middle" : "end"} fill="currentColor">
            {fmt(t)}
          </text>
        ))}
        {Array.from({ length: n }, (_, i) => {
          const c = (horizontal ? T : L) + bandSize * (i + 0.5);
          return (
            <text key={i} x={horizontal ? L - 4 : c} y={horizontal ? c + 3 : T + ph + 12} fontSize={9} textAnchor={horizontal ? "end" : "middle"} fill="currentColor">
              {label(i)}
            </text>
          );
        })}
        {kind === "line"
          ? series.map((s, si) => {
              const pts = s.vals.map((v, i) => `${L + bandSize * (i + 0.5)},${val(v)}`);
              return (
                <g key={si}>
                  <polyline points={pts.join(" ")} fill="none" stroke={col(si)} strokeWidth={2} />
                  {s.vals.map((v, i) => (
                    <circle key={i} cx={L + bandSize * (i + 0.5)} cy={val(v)} r={2.5} fill={col(si)} />
                  ))}
                </g>
              );
            })
          : series.map((s, si) =>
              s.vals.map((v, i) => {
                const start = (horizontal ? T : L) + bandSize * i + bandSize * 0.1 + barW * si;
                return horizontal ? (
                  <rect key={`${si}-${i}`} x={Math.min(L + (0 - min) / span * pw, val(v))} y={start} width={Math.abs(val(v) - (L + ((0 - min) / span) * pw))} height={barW} fill={col(si)} />
                ) : (
                  <rect key={`${si}-${i}`} x={start} y={Math.min(zero, val(v))} width={barW} height={Math.abs(zero - val(v))} fill={col(si)} />
                );
              }),
            )}
        {series.length > 1 &&
          series.slice(0, 6).map((s, i) => (
            <g key={i}>
              <rect x={L + i * 70} y={H - 12} width={8} height={8} fill={col(i)} />
              <text x={L + i * 70 + 11} y={H - 5} fontSize={9} fill="currentColor">
                {s.name.slice(0, 9)}
              </text>
            </g>
          ))}
      </>
    );
  })();
  return (
    <svg viewBox={`0 0 ${W} ${H + (title ? 18 : 0)}`} width="100%" height="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label={title || "Chart"}>
      {title && (
        <text x={W / 2} y={13} fontSize={13} fontWeight={700} textAnchor="middle" fill="currentColor">
          {title}
        </text>
      )}
      <g transform={title ? "translate(0 18)" : undefined}>{body}</g>
    </svg>
  );
}

function Sheets({ sheets }: { sheets: Sheet[] }) {
  return (
    <div className="space-y-6">
      {sheets.map((sh, i) => (
        <section key={i}>
          {sh.name && <h3 className="mb-2 font-display text-ink">{sh.name}</h3>}
          <div className="max-h-[70vh] overflow-auto border border-line">
            <table className="min-w-full border-collapse text-left text-sm text-ink">
              <tbody>
                {sh.rows.map((r, ri) => (
                  <tr key={ri} className={ri === 0 ? "sticky top-0 bg-sunken" : "border-t border-line"}>
                    {r.map((c, ci) =>
                      ri === 0 ? (
                        <th key={ci} className="whitespace-nowrap px-3 py-1.5 font-semibold">
                          {c}
                        </th>
                      ) : (
                        <td key={ci} className="whitespace-nowrap px-3 py-1.5">
                          {c}
                        </td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {sh.total > sh.rows.length && (
            <p className="mt-1 text-sm text-muted">
              Showing first {sh.rows.length} of {sh.total} rows.
            </p>
          )}
        </section>
      ))}
    </div>
  );
}

function WordDoc({ blocks }: { blocks: DocBlock[] }) {
  const imgs = useMemo(() => blocks.flatMap((b) => (b.type === "img" ? [b.img] : [])), [blocks]);
  const urls = useImageUrls(imgs);
  let k = 0;
  return (
    <div className="space-y-3 border border-line bg-card p-4 text-ink">
      {blocks.map((b, i) => {
        if (b.type === "h")
          return (
            <p key={i} className={`font-display ${b.level <= 1 ? "text-xl" : b.level === 2 ? "text-lg" : "text-base"}`}>
              {b.text}
            </p>
          );
        if (b.type === "p")
          return (
            <p key={i} className={`whitespace-pre-line ${b.list ? "ml-5" : ""}`}>
              {b.list ? "• " : ""}
              {b.text}
            </p>
          );
        if (b.type === "table")
          return (
            <div key={i} className="overflow-auto border border-line">
              <table className="min-w-full border-collapse text-left text-sm">
                <tbody>
                  {b.rows.map((r, ri) => (
                    <tr key={ri} className={ri ? "border-t border-line" : ""}>
                      {r.map((c, ci) => (
                        <td key={ci} className="whitespace-pre-line px-3 py-1.5 align-top">
                          {c}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        const u = urls[k++];
        // eslint-disable-next-line @next/next/no-img-element
        return u ? <img key={i} src={u} alt="" className="h-auto max-w-full border border-line" /> : null;
      })}
    </div>
  );
}

function LinkOut({ url, label }: { url: string | null; label: string }) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return (
    <div className="border border-line px-5 py-6">
      <a href={url} target="_blank" rel="noopener noreferrer" className={btn}>
        {label}
      </a>
      <p className="mt-3 break-all text-sm text-muted">{url}</p>
    </div>
  );
}
