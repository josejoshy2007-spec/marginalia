"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, type ArtifactDetail, type ArtifactKind, type ArtifactSummary, type Citation, type GenerateRequest, type Source } from "@/lib/api";
import { resolveCites } from "@/lib/cite";

export type StudyProps = {
  subjectId: number;
  checkedIds: number[];
  totalSources: number;
  onCite: (c: Citation) => void;
  onGoLibrary: () => void;
  /** All sources of the subject (for pickers); optional so older call sites keep working. */
  sources?: Source[];
  onSourcesChanged?: () => Promise<unknown>;
  /** e.g. "IB Computer Science HL" when the subject has an IB course set. */
  ibLabel?: string | null;
};

/** Numbered citation chips for a card/question/line, opening the passage in Read. */
export function CiteMarks({
  cite,
  passages,
  onCite,
}: {
  cite: number[] | undefined;
  passages: Citation[];
  onCite: (c: Citation) => void;
}) {
  const cites = resolveCites(cite, passages);
  if (!cites.length) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-0.5 align-middle">
      {cites.map((c, i) => (
        <button
          key={i}
          type="button"
          className="cite-marker"
          onClick={(e) => {
            e.stopPropagation();
            onCite(c);
          }}
          title={`${c.source_title}${c.page ? ` · ${c.page_label ?? "p."} ${c.page}` : ""}\n“${c.cited_text.slice(0, 160)}”`}
        >
          {(cite ?? [])[i]}
        </button>
      ))}
    </span>
  );
}

const ARTIFACTS_CHANGED = "marginalia:artifacts-changed";

/** Loads a subject's artifacts of one kind and runs generation requests against them. */
export function useArtifacts(subjectId: number, kind: ArtifactKind) {
  const [items, setItems] = useState<ArtifactSummary[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setItems(await api.artifacts(subjectId, kind));
    } catch (e) {
      setError((e as Error).message);
      setItems([]);
    }
  }, [subjectId, kind]);

  useEffect(() => {
    setItems(null);
    refresh();
  }, [refresh]);

  // A generation request can finish after the screen that sent it was left and re-opened
  // (a new hook instance); it announces itself so whichever list is showing now picks it up.
  useEffect(() => {
    const onChanged = (e: Event) => {
      const d = (e as CustomEvent<{ subjectId: number; kind: ArtifactKind }>).detail;
      if (d.subjectId === subjectId && d.kind === kind) refresh();
    };
    window.addEventListener(ARTIFACTS_CHANGED, onChanged);
    return () => window.removeEventListener(ARTIFACTS_CHANGED, onChanged);
  }, [subjectId, kind, refresh]);

  // Generation runs on the server in the background: poll until nothing is processing.
  const processing = !!items?.some((a) => a.status === "processing");
  useEffect(() => {
    if (!processing) return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [processing, refresh]);

  // "Open it when it's done" for the item just started, if this screen is still showing.
  const pending = useRef<{ id: number; open: (id: number) => void } | null>(null);
  useEffect(() => {
    const want = pending.current;
    const item = want && items?.find((a) => a.id === want.id);
    if (!want || !item || item.status === "processing") return;
    pending.current = null;
    if (item.status === "ready") want.open(item.id);
  }, [items]);

  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 12000);
    return () => clearTimeout(t);
  }, [notice]);

  const lastRequest = useRef<{ req: Omit<GenerateRequest, "kind">; label: string; opts: { openWhenReady?: (id: number) => void } } | null>(null);

  /** Start generating. Returns as soon as the server has queued it (status "processing"). */
  const generate = useCallback(
    async (
      req: Omit<GenerateRequest, "kind">,
      label: string,
      opts: { openWhenReady?: (id: number) => void } = {},
    ): Promise<ArtifactDetail | null> => {
      lastRequest.current = { req, label, opts };
      setBusy(label);
      setError(null);
      try {
        const created = await api.generate(subjectId, { ...req, kind });
        window.dispatchEvent(new CustomEvent(ARTIFACTS_CHANGED, { detail: { subjectId, kind } }));
        if (opts.openWhenReady) pending.current = { id: created.id, open: opts.openWhenReady };
        setNotice("Writing it in the background. You can leave this page; it'll be in the list below.");
        await refresh();
        return created;
      } catch (e) {
        setError((e as Error).message);
        return null;
      } finally {
        setBusy(null);
      }
    },
    [subjectId, kind, refresh],
  );

  const remove = useCallback(
    async (id: number) => {
      await api.deleteArtifact(id);
      await refresh();
    },
    [refresh],
  );

  /** Re-run a failed item in place (same settings). */
  const retry = useCallback(
    async (id: number) => {
      setError(null);
      try {
        await api.retryArtifact(id);
        await refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [refresh],
  );

  /** Resend the last generate request (when starting it failed, e.g. the server was busy). */
  const retryLast = useCallback(() => {
    const last = lastRequest.current;
    if (last) void generate(last.req, last.label, last.opts);
  }, [generate]);

  return { items, busy, notice, error, setError, refresh, generate, remove, retry, retryLast };
}

/** Feedback under a generator form: "Starting…" while the request is sent, then the background notice. */
export function Working({ label, notice }: { label?: string | null; notice?: string | null }) {
  const text = label || notice;
  if (!text) return null;
  return (
    <div className="mt-4 flex items-center gap-3 rounded-xl border border-line bg-card px-4 py-3 text-sm">
      <span className="relative flex h-2.5 w-2.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent" />
      </span>
      <span>
        {label ? `${label} Starting…` : notice}{" "}
        {!label && <span className="text-muted">Gemini usually takes 30–90 seconds.</span>}
      </span>
    </div>
  );
}

export const isReady = (a: ArtifactSummary) => (a.status ?? "ready") === "ready";

/** Shown in place of an item's details while it's being generated, or if generating failed. */
export function JobStatus({ a, onRetry }: { a: ArtifactSummary; onRetry?: (id: number) => void }) {
  if (a.status === "processing")
    return (
      <span className="mt-1 block">
        <span className="block text-xs text-muted">{a.stage ?? "Queued"}…</span>
        <span className="mt-1 block h-1 max-w-xs overflow-hidden rounded-full bg-sunken">
          <span
            className="block h-full animate-pulse bg-accent transition-all duration-700"
            style={{ width: `${Math.max(12, (a.progress ?? 0) * 100)}%` }}
          />
        </span>
      </span>
    );
  if (a.status === "failed")
    return (
      <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-danger">
        <span>{a.error ?? "Failed."}</span>
        {onRetry && <RetryLink onRetry={() => onRetry(a.id)} />}
      </span>
    );
  return null;
}

export function ErrorNote({ text, onClose, onRetry }: { text: string; onClose?: () => void; onRetry?: () => void }) {
  return (
    <p className="mt-3 flex items-start justify-between gap-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
      <span>{text}</span>
      <span className="flex shrink-0 gap-3">
        {onRetry && <RetryLink onRetry={onRetry} />}
        {onClose && (
          <button type="button" onClick={onClose} className="underline">
            dismiss
          </button>
        )}
      </span>
    </p>
  );
}

/**
 * "Try again" for anything Gemini can fail at (overloaded, quota, dropped connection). Rendered as a
 * span with button semantics because it often sits inside a row that is itself a <button>.
 */
export function RetryLink({ onRetry, label = "Try again" }: { onRetry: () => void; label?: string }) {
  const [spinning, setSpinning] = useState(false);
  const go = (e: { stopPropagation: () => void; preventDefault: () => void }) => {
    e.stopPropagation();
    e.preventDefault();
    if (spinning) return;
    setSpinning(true);
    Promise.resolve(onRetry()).finally(() => setTimeout(() => setSpinning(false), 800));
  };
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={go}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && go(e)}
      className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-current px-2 py-0.5 font-medium hover:bg-danger hover:text-white"
    >
      <span className={spinning ? "inline-block animate-spin" : "inline-block"}>↻</span> {label}
    </span>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-full bg-sunken p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-full px-3 py-1 text-sm transition-colors ${
            value === o.value ? "bg-card text-ink shadow-sm" : "text-muted hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ModeHeader({ eyebrow, title, children }: { eyebrow: string; title: ReactNode; children?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-6">
      <div>
        <p className="text-xs uppercase tracking-[0.18em] text-muted">{eyebrow}</p>
        <h1 className="mt-1 font-display text-4xl leading-tight">{title}</h1>
      </div>
      {children}
    </header>
  );
}

export function IBBadge({ label }: { label?: string | null }) {
  if (!label) return null;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-moss/40 bg-moss/10 px-2.5 py-0.5 text-xs font-medium text-moss">
      <span className="h-1.5 w-1.5 rounded-full bg-moss" />
      Written for {label}
    </span>
  );
}

export function NoSources({ onGoLibrary }: { onGoLibrary: () => void }) {
  return (
    <p className="mt-8 rounded-2xl border border-dashed border-line px-6 py-10 text-center text-muted">
      Nothing to work from yet.{" "}
      <button type="button" onClick={onGoLibrary} className="text-accent underline underline-offset-4">
        Add or check a source in the Library
      </button>{" "}
      first.
    </p>
  );
}

export function scopeLabel(checked: number, total: number) {
  if (!total) return "no sources";
  return checked === total ? `all ${total} source${total === 1 ? "" : "s"}` : `${checked} of ${total} sources`;
}

export function timeUntil(iso: string | null) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "now";
  const m = ms / 60000;
  if (m < 60) return `in ${Math.ceil(m)} min`;
  const h = m / 60;
  if (h < 24) return `in ${Math.round(h)} h`;
  return `in ${Math.round(h / 24)} days`;
}
