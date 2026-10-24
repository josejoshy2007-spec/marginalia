"use client";

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { api, ENGINE, KIND_LABEL, pageLabel, type Citation, type Source, type Subject } from "@/lib/api";
import { FileIcon, LinkIcon, MicIcon, NoteIcon, PlusIcon, TrashIcon } from "./icons";
import SheetsPanel from "./SheetsPanel";
import { ErrorNote, Segmented } from "./study/shared";
import { askConfirm } from "@/lib/confirm";

type Props = {
  subjects: Subject[] | null;
  subject: Subject | null;
  sources: Source[];
  loadError: string | null;
  onSelectSubject: (id: number) => void;
  onSubjectsChanged: (selectId?: number) => Promise<void>;
  onSourcesChanged: () => Promise<void>;
  setSources: Dispatch<SetStateAction<Source[]>>;
  onOpen: (sourceId: number) => void;
  onCite: (c: Citation) => void;
};

/** The shelf is split by medium: things you read vs. things you listen to. */
const SHELF_SECTIONS: { title: string; blurb: string; Icon: typeof FileIcon; kinds: Source["kind"][] }[] = [
  {
    title: "Documents",
    blurb: "PDFs, slides, documents, spreadsheets, notes and web pages",
    Icon: FileIcon,
    kinds: ["pdf", "slides", "doc", "sheet", "image", "text", "url"],
  },
  { title: "Audio", blurb: "Lecture recordings and videos, as transcripts", Icon: MicIcon, kinds: ["audio", "video"] },
];

export default function LibraryMode(p: Props) {
  const [view, setView] = useState<"shelf" | "sheets">("shelf");
  if (p.subjects === null) return <div className="p-10 text-muted">Loading…</div>;
  if (!p.subject)
    return (
      <div className="mx-auto max-w-xl px-6 pt-24">
        {p.loadError && <ErrorNote text={p.loadError} onRetry={() => window.location.reload()} />}
        <p className="font-display text-4xl leading-tight">
          Start a subject, <em className="text-accent">then feed it sources.</em>
        </p>
        <p className="mt-3 text-muted">
          A subject is a shelf for one course or topic. Everything you ask is answered only from the sources on that
          shelf, with every claim pinned to a passage you can jump to.
        </p>
        <NewSubject onCreated={(s) => p.onSubjectsChanged(s.id)} autoFocus />
      </div>
    );

  return (
    <div className="mx-auto max-w-5xl px-6 pt-10 sm:px-10">
      {p.loadError && <ErrorNote text={p.loadError} onRetry={() => window.location.reload()} />}
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-6">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-muted">Subject</p>
          <SubjectSwitcher {...p} />
          <IBCoursePicker subject={p.subject} onChanged={() => p.onSubjectsChanged()} />
        </div>
        <NewSubject compact onCreated={(s) => p.onSubjectsChanged(s.id)} />
      </header>

      <div className="mt-6">
        <Segmented
          label="Library view"
          value={view}
          onChange={setView}
          options={[
            { value: "shelf", label: `Sources (${p.sources.length})` },
            { value: "sheets", label: "Study sheets" },
          ]}
        />
      </div>

      {view === "sheets" ? (
        <SheetsPanel
          subjectId={p.subject.id}
          checkedIds={p.sources.filter((s) => s.checked).map((s) => s.id)}
          totalSources={p.sources.length}
          onCite={p.onCite}
          onGoLibrary={() => setView("shelf")}
        />
      ) : (
      <>
      <AddSource subjectId={p.subject.id} onAdded={p.onSourcesChanged} />

      <section className="mt-10">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="font-display text-2xl">On the shelf</h2>
          {p.sources.length > 0 && (
            <p className="text-sm text-muted">
              {p.sources.filter((s) => s.checked).length} of {p.sources.length} in play for answers
            </p>
          )}
        </div>
        {p.sources.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line px-6 py-10 text-center text-muted">
            Nothing here yet. Add a PDF, paste notes, or drop in a link above.
          </p>
        ) : (
          <div className="space-y-8">
            {SHELF_SECTIONS.map(({ title, blurb, Icon, kinds }) => {
              const items = p.sources.filter((s) => kinds.includes(s.kind));
              if (!items.length) return null;
              return (
                <div key={title}>
                  <div className="mb-3 flex items-center gap-2 border-b border-line pb-2">
                    <Icon width={16} height={16} className="text-muted" />
                    <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-ink-soft">{title}</h3>
                    <span className="rounded-full bg-sunken px-2 text-xs text-muted">{items.length}</span>
                    <span className="ml-auto hidden text-xs text-muted sm:inline">{blurb}</span>
                  </div>
                  <ul className="grid gap-3 sm:grid-cols-2">
                    {items.map((s) => (
                      <SourceCard key={s.id} source={s} {...p} />
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </section>
      </>
      )}
    </div>
  );
}

function SubjectSwitcher({ subjects, subject, onSelectSubject, onSubjectsChanged }: Props) {
  return (
    <div className="flex items-center gap-3">
      <select
        aria-label="Current subject"
        value={subject!.id}
        onChange={(e) => onSelectSubject(Number(e.target.value))}
        className="max-w-[70vw] cursor-pointer appearance-none bg-transparent font-display text-4xl leading-tight outline-none"
      >
        {subjects!.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        title="Delete this subject and its sources"
        className="text-muted hover:text-danger"
        onClick={async () => {
          if (!(await askConfirm(`Delete “${subject!.name}”?`, { detail: "Its sources, cards, quizzes, summaries and everything else made from them are deleted too." }))) return;
          await api.deleteSubject(subject!.id);
          const rest = subjects!.filter((s) => s.id !== subject!.id);
          await onSubjectsChanged(rest[0]?.id);
        }}
      >
        <TrashIcon width={18} height={18} />
      </button>
    </div>
  );
}

function NewSubject({
  onCreated,
  compact,
  autoFocus,
}: {
  onCreated: (s: Subject) => void;
  compact?: boolean;
  autoFocus?: boolean;
}) {
  const [name, setName] = useState("");
  const [open, setOpen] = useState(!compact);
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn-ghost">
        <PlusIcon width={16} height={16} /> New subject
      </button>
    );
  return (
    <form
      className={`flex gap-2 ${compact ? "" : "mt-8"}`}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        const s = await api.createSubject(name.trim());
        setName("");
        if (compact) setOpen(false);
        onCreated(s);
      }}
    >
      <input
        autoFocus={autoFocus || compact}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Cell Biology, AP History…"
        className="field min-w-0 flex-1"
      />
      <button className="btn-primary" type="submit">
        Create
      </button>
    </form>
  );
}

type Tab = "pdf" | "text" | "url" | "audio";

function AddSource({ subjectId, onAdded }: { subjectId: number; onAdded: () => Promise<void> }) {
  const [tab, setTab] = useState<Tab>("pdf");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const lastRun = useRef<{ label: string; fn: () => Promise<unknown> } | null>(null);
  const run = async (label: string, fn: () => Promise<unknown>) => {
    lastRun.current = { label, fn };
    setBusy(label);
    setError(null);
    try {
      await fn();
      await onAdded();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const uploadFiles = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      const mb = (f.size / 1024 / 1024).toFixed(f.size > 10 * 1024 * 1024 ? 0 : 1);
      await run(`Adding ${f.name} (${mb} MB)…`, () =>
        api.addFile(subjectId, f, (frac) => setBusy(`Adding ${f.name} (${mb} MB)… ${Math.round(frac * 100)}%`)),
      );
    }
  };

  const tabs: { id: Tab; label: string; Icon: typeof FileIcon }[] = [
    { id: "pdf", label: "File", Icon: FileIcon },
    { id: "text", label: "Paste text", Icon: NoteIcon },
    { id: "url", label: "Link or YouTube", Icon: LinkIcon },
    { id: "audio", label: "Lecture audio", Icon: MicIcon },
  ];

  return (
    <section className="mt-8 rounded-2xl border border-line bg-card p-5 shadow-[0_1px_0_var(--color-line)]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-2 font-display text-xl">Add a source</span>
        {tabs.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-sm transition-colors ${
              tab === id ? "bg-ink text-paper" : "text-muted hover:bg-sunken hover:text-ink"
            }`}
          >
            <Icon width={15} height={15} /> {label}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {tab === "pdf" && (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              uploadFiles(e.dataTransfer.files);
            }}
            onClick={() => fileRef.current?.click()}
            className={`grid cursor-pointer place-items-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
              drag ? "border-accent bg-accent-soft" : "border-line hover:border-muted"
            }`}
          >
            <p className="font-medium">
              <span className="hidden sm:inline">Drop files here or click to choose</span>
              <span className="sm:hidden">Tap to choose files</span>
            </p>
            <p className="mt-1 text-sm text-muted">
              {ENGINE === "local"
                ? "PDF, PowerPoint, Word, Excel or CSV, EPUB, text files, or photos of notes. Pages and slide numbers are kept for citations."
                : "PDF textbooks up to 600 MB. Other file types work in the phone and web app."}
            </p>
            <input
              ref={fileRef}
              type="file"
              accept={
                ENGINE === "local"
                  ? ".pdf,.pptx,.ppsx,.potx,.odp,.docx,.dotx,.odt,.xlsx,.xlsm,.ods,.csv,.tsv,.epub,.txt,.md,.rtf,.html,.htm,image/*,application/pdf"
                  : "application/pdf,.pdf"
              }
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) uploadFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
        )}
        {tab === "text" && (
          <form
            className="flex flex-col gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!text.trim()) return;
              if (await run("Adding notes…", () => api.addText(subjectId, title.trim(), text))) {
                setTitle("");
                setText("");
              }
            }}
          >
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional)" className="field" />
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Paste lecture notes, an article, a chapter…"
              rows={7}
              className="field resize-y font-reading leading-relaxed"
            />
            <div>
              <button className="btn-primary" type="submit" disabled={!!busy || !text.trim()}>
                Add to shelf
              </button>
            </div>
          </form>
        )}
        {tab === "url" && (
          <form
            className="flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!url.trim()) return;
              const yt = /youtu\.?be/.test(url);
              if (await run(yt ? "Transcribing the video with Gemini (can take a minute)…" : "Fetching page…", () => api.addUrl(subjectId, url.trim()))) setUrl("");
            }}
          >
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="A web page, PDF link, or YouTube video URL"
              className="field min-w-0 flex-1"
              inputMode="url"
            />
            <button className="btn-primary" type="submit" disabled={!!busy || !url.trim()}>
              Fetch
            </button>
          </form>
        )}
        {tab === "audio" && (
          <AudioInput
            disabled={!!busy}
            onAudio={(blob, name) =>
              run("Uploading the recording…", () =>
                api.addRecording(subjectId, blob, name, (f) => setBusy(`Uploading the recording… ${Math.round(f * 100)}%`)),
              )
            }
          />
        )}
      </div>
      {busy && <p className="mt-3 animate-pulse text-sm text-muted">{busy}</p>}
      {error && (
        <ErrorNote
          text={error}
          onClose={() => setError(null)}
          onRetry={lastRun.current ? () => run(lastRun.current!.label, lastRun.current!.fn) : undefined}
        />
      )}
    </section>
  );
}

function SourceCard({ source: s, setSources, onSourcesChanged, onOpen }: Props & { source: Source }) {
  const kindLabel = KIND_LABEL[s.kind];
  const meta = [
    kindLabel,
    s.page_count
      ? `${s.page_count} ${s.kind === "pdf" ? "pp." : s.page_count === 1 ? pageLabel(s.kind).one : pageLabel(s.kind).many}`
      : `${Math.max(1, Math.round(s.char_count / 5 / 250))} min read`,
    `${s.chunk_count} passages`,
  ].join(" · ");
  return (
    <li
      className={`group relative flex gap-3 rounded-2xl border bg-card p-4 transition-all ${
        s.checked ? "border-line" : "border-dashed border-line opacity-60"
      }`}
    >
      <label className="mt-0.5 flex cursor-pointer items-start" title="Use this source when answering">
        <input
          type="checkbox"
          checked={s.checked}
          onChange={async (e) => {
            const checked = e.target.checked;
            setSources((list) => list.map((x) => (x.id === s.id ? { ...x, checked } : x)));
            await api.patchSource(s.id, { checked });
          }}
          className="peer sr-only"
        />
        <span className="grid h-5 w-5 place-items-center rounded-md border border-muted text-[11px] text-paper peer-checked:border-moss peer-checked:bg-moss peer-focus-visible:ring-2 peer-focus-visible:ring-accent">
          {s.checked ? "✓" : ""}
        </span>
      </label>
      <button type="button" onClick={() => s.status === "ready" && onOpen(s.id)} className="min-w-0 flex-1 text-left">
        <p className="line-clamp-2 font-display text-lg leading-snug group-hover:underline group-hover:decoration-accent group-hover:underline-offset-4">
          {s.title}
        </p>
        {s.status === "processing" ? (
          <div className="mt-2">
            <p className="text-xs text-muted">
              {s.stage ?? (s.kind === "audio" ? "Transcribing" : "Processing")}…{" "}
              {s.progress != null ? `${Math.round(s.progress * 100)}%` : ""}
            </p>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-sunken">
              <div className="h-full bg-accent transition-all duration-700" style={{ width: `${Math.max(3, (s.progress ?? 0) * 100)}%` }} />
            </div>
          </div>
        ) : s.status === "failed" ? (
          <p className="mt-1 text-xs text-danger">
            {s.error ?? "Processing failed."}{" "}
            {s.can_retry && (
              <span
                role="button"
                tabIndex={0}
                className="font-medium underline underline-offset-2"
                onClick={async (e) => {
                  e.stopPropagation();
                  await api.retrySource(s.id);
                  await onSourcesChanged();
                }}
              >
                Retry
              </span>
            )}
          </p>
        ) : (
          <p className="mt-1 text-xs text-muted">{meta}</p>
        )}
        {s.url && <p className="mt-1 truncate text-xs text-muted">{s.url}</p>}
      </button>
      <button
        type="button"
        title="Remove source"
        onClick={async () => {
          if (!(await askConfirm(`Remove “${s.title}”?`, { confirmLabel: "Remove" }))) return;
          setSources((list) => list.filter((x) => x.id !== s.id)); // hide it now; refresh confirms
          try {
            await api.deleteSource(s.id);
          } finally {
            await onSourcesChanged();
          }
        }}
        className="self-start text-muted opacity-0 transition-opacity hover:text-danger group-hover:opacity-100 focus:opacity-100"
      >
        <TrashIcon width={16} height={16} />
      </button>
    </li>
  );
}


/** Upload a recording or record one in the browser; Gemini transcribes it into a source. */
function AudioInput({ disabled, onAudio }: { disabled: boolean; onAudio: (b: Blob, name: string) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);

  const start = async () => {
    setMicError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const parts: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const type = rec.mimeType || "audio/webm";
        const stamp = new Date().toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
        onAudio(new Blob(parts, { type }), `Lecture ${stamp}.${type.includes("ogg") ? "ogg" : "webm"}`);
      };
      rec.start(1000);
      recRef.current = rec;
      setSeconds(0);
      setRecording(true);
    } catch {
      setMicError("Couldn't use the microphone. Check the browser's permission for this site.");
    }
  };

  const stop = () => {
    recRef.current?.stop();
    setRecording(false);
  };

  const mmss = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <button
        type="button"
        disabled={disabled}
        onClick={() => (recording ? stop() : start())}
        className={`flex items-center justify-center gap-3 rounded-xl border-2 px-6 py-8 transition-colors ${
          recording ? "border-danger bg-danger-soft text-danger" : "border-dashed border-line hover:border-muted"
        }`}
      >
        <span className={`h-3 w-3 rounded-full ${recording ? "animate-pulse bg-danger" : "bg-accent"}`} />
        <span className="font-medium">{recording ? `Stop and transcribe · ${mmss}` : "Record a lecture"}</span>
      </button>
      <button
        type="button"
        disabled={disabled || recording}
        onClick={() => fileRef.current?.click()}
        className="rounded-xl border-2 border-dashed border-line px-6 py-8 hover:border-muted"
      >
        <span className="font-medium">Upload a recording</span>
        <span className="mt-1 block text-sm text-muted">Any audio or video format · up to 2 hours</span>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*,video/*,.m4a,.opus,.flac,.aac,.wma,.amr,.mkv,.mov"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onAudio(f, f.name);
            e.target.value = "";
          }}
        />
      </button>
      {micError && <p className="text-sm text-danger sm:col-span-2">{micError}</p>}
      <p className="text-xs text-muted sm:col-span-2">
        Transcribed on this computer with Whisper: free, private, no quota. A 2-hour lecture takes roughly 10–20
        minutes, and you can keep studying meanwhile. The transcript gets (mm:ss) timestamps and then works like any
        other source.
      </p>
    </div>
  );
}

/** Sets the subject's IB course + level; every generator and the chat then follow IB conventions. */
function IBCoursePicker({ subject, onChanged }: { subject: Subject; onChanged: () => void }) {
  const [courses, setCourses] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api.ibOptions().then((o) => setCourses(o.courses)).catch(() => {});
  }, []);
  const save = async (patch: { ib_course?: string; ib_level?: "SL" | "HL" | "" }) => {
    setSaving(true);
    try {
      await api.patchSubject(subject.id, patch);
      onChanged();
    } finally {
      setSaving(false);
    }
  };
  const course = subject.ib_course ?? "";
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted">IB course</span>
      <select
        aria-label="IB course"
        value={course}
        disabled={saving}
        onChange={(e) => save({ ib_course: e.target.value })}
        className="min-w-0 max-w-full cursor-pointer truncate rounded-full border border-line bg-card px-3 py-1 outline-none hover:border-muted"
      >
        <option value="">Not an IB subject</option>
        {course && !courses.includes(course) && <option value={course}>{course}</option>}
        {courses.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      {course && (
        <Segmented
          label="IB level"
          value={(subject.ib_level ?? "") as "SL" | "HL" | ""}
          onChange={(v) => save({ ib_level: v })}
          options={[
            { value: "SL", label: "SL" },
            { value: "HL", label: "HL" },
          ]}
        />
      )}
      {course && <span className="text-xs text-moss">Questions, notes and answers follow IB style</span>}
    </div>
  );
}
