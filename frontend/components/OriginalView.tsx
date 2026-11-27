"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Source } from "@/lib/api";
import { saveFile } from "@/lib/native";
import { youtubeEmbedUrl, youtubeId } from "@/lib/original";
import { MAX_ZIP, viewCsv, viewDocx, viewPptx, viewXlsx, type DocBlock, type Img, type Sheet, type Slide } from "@/lib/office-view";

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

function Slides({ slides }: { slides: Slide[] }) {
  const all = useMemo(() => slides.flatMap((s) => s.images), [slides]);
  const urls = useImageUrls(all);
  const starts = slides.reduce<number[]>((a, s, i) => (a.push(i ? a[i - 1] + slides[i - 1].images.length : 0), a), []);
  return (
    <div className="space-y-4">
      {slides.map((s, si) => (
        <section key={s.n} className="border border-line bg-card p-3">
          <p className="text-xs text-muted">Slide {s.n}</p>
          <div className="mt-2 flex aspect-video w-full flex-col overflow-auto border border-line bg-sunken p-4">
            {s.title && <h3 className="font-display text-lg text-ink">{s.title}</h3>}
            {s.paras.map((t, i) => (
              <p key={i} className="mt-2 whitespace-pre-line text-sm text-ink">
                {t}
              </p>
            ))}
            {s.images.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {s.images.map((_, i) => {
                  const u = urls[starts[si] + i];
                  // eslint-disable-next-line @next/next/no-img-element
                  return u ? <img key={i} src={u} alt="" className="h-auto max-h-40 max-w-full border border-line" /> : null;
                })}
              </div>
            )}
          </div>
        </section>
      ))}
    </div>
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
