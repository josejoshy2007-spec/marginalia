"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { api, type Citation } from "@/lib/api";
import { askConfirm } from "@/lib/confirm";
import { isNative, nativePhoto } from "@/lib/native";
import { shrink, usePasteImages } from "@/lib/photos";
import { newThreadId, threadTitle, type AskImage, type Thread } from "@/lib/threads";
import AnswerBody from "./AnswerBody";
import { ArrowUpIcon, CameraIcon, CloseIcon, MicIcon, PlusIcon, TrashIcon } from "./icons";
import { ErrorNote, RetryLink, Segmented } from "./study/shared";

type AskMode = "sources" | "general";

const MAX_PHOTOS = 4;
const MAX_VOICE_SECONDS = 120;

function when(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days < 1) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

/**
 * Ask AI: saved conversations for the current subject. "From my sources" answers only from the
 * checked sources with citations (like the bottom bar); "Ask anything" is a general tutor, clearly
 * labelled as not coming from the student's sources. Conversations are saved per subject and sync
 * through Google Drive. The bottom bar's quick answers appear here too. Questions can carry up to
 * four photos and be dictated by voice (on-device engine).
 */
export default function AskMode({
  threads,
  activeId,
  setActiveId,
  onAsk,
  onSetMode,
  onDelete,
  onRetry,
  onCite,
  checkedCount,
  totalCount,
  onGoLibrary,
  generalAvailable,
}: {
  threads: Thread[];
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  onAsk: (thread: Thread, message: string, fresh?: boolean, images?: AskImage[]) => void;
  onSetMode: (thread: Thread, mode: AskMode) => void;
  onDelete: (id: string) => void;
  onRetry: (thread: Thread) => void;
  onCite: (c: Citation) => void;
  checkedCount: number;
  totalCount: number;
  onGoLibrary: () => void;
  generalAvailable: boolean;
}) {
  const conversations = useMemo(
    () =>
      threads
        .filter((t) => (t.kind === "ask" || t.kind === "sheet") && t.turns.length > 0)
        .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")),
    [threads],
  );
  // A not-yet-sent conversation lives here until its first question.
  const [draft, setDraft] = useState<Thread>(() => newDraft("sources"));
  const active = threads.find((t) => t.id === activeId) ?? draft;
  const isDraft = active.id === draft.id;
  // Phones show one pane at a time: the list, or the open conversation.
  const [showList, setShowList] = useState(conversations.length > 0 && !activeId);

  function newDraft(mode: AskMode): Thread {
    return { id: newThreadId(), kind: "ask", mode, turns: [], busy: false };
  }
  const startNew = () => {
    const d = newDraft(active.mode ?? "sources");
    setDraft(d);
    setActiveId(d.id);
    setShowList(false);
  };
  const open = (id: string) => {
    setActiveId(id);
    setShowList(false);
  };

  const send = (text: string, images?: AskImage[]) => {
    if (isDraft) {
      setDraft(newDraft(active.mode ?? "sources")); // the sent draft becomes a saved conversation
      setActiveId(active.id);
    }
    onAsk(active, text, false, images);
  };

  const mode: AskMode = active.mode ?? "sources";
  const viewRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={viewRef} className="mx-auto flex h-full max-w-6xl gap-8 px-4 pt-6 sm:px-8">
      <aside className={`${showList ? "flex" : "hidden"} min-w-0 flex-1 flex-col lg:flex lg:w-72 lg:flex-none`}>
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-[0.12em] text-muted">Ask AI</p>
            <h1 className="truncate font-display text-2xl leading-tight">Conversations</h1>
          </div>
          <button type="button" className="btn-ghost shrink-0" onClick={startNew}>
            <PlusIcon width={16} height={16} /> New
          </button>
        </div>
        <ul className="mt-5 flex flex-col gap-1 overflow-y-auto pb-6">
          {conversations.length === 0 && <li className="text-sm text-muted">Nothing yet. Your questions are saved here, per subject.</li>}
          {conversations.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => open(t.id)}
                className={`w-full rounded-xl px-3 py-2.5 text-left transition-colors ${
                  t.id === active.id ? "bg-card ring-1 ring-line" : "hover:bg-card/60"
                }`}
              >
                <span className="line-clamp-2 text-sm font-medium">{t.kind === "sheet" ? "Quick questions" : threadTitle(t)}</span>
                <span className="mt-0.5 block text-xs text-muted">
                  {t.kind === "sheet" ? "From the bottom bar" : t.mode === "general" ? "Ask anything" : "From my sources"}
                  {t.updatedAt ? ` · ${when(t.updatedAt)}` : ""}
                  {t.busy ? " · answering…" : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className={`${showList ? "hidden" : "flex"} min-h-full min-w-0 flex-1 flex-col lg:flex`}>
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
          <div className="flex min-w-0 items-center gap-3">
            <button type="button" className="btn-ghost !px-2 lg:!hidden" onClick={() => setShowList(true)} aria-label="All conversations">
              ← <span className="text-sm">All</span>
            </button>
            <h2 className="truncate font-display text-2xl leading-tight">
              {isDraft ? "New conversation" : active.kind === "sheet" ? "Quick questions" : threadTitle(active)}
            </h2>
          </div>
          <div className="flex items-center gap-2">
            {generalAvailable && (
              <Segmented
                label="Answer from"
                value={mode}
                options={[
                  { value: "sources", label: "From my sources" },
                  { value: "general", label: "Ask anything" },
                ]}
                onChange={(m) => (isDraft ? setDraft({ ...draft, mode: m }) : onSetMode(active, m))}
              />
            )}
            {!isDraft && (
              <button
                type="button"
                className="btn-ghost !px-2"
                title="Delete this conversation"
                aria-label="Delete this conversation"
                onClick={async () => {
                  if (await askConfirm("Delete this conversation?", { detail: "It's removed from every synced device." })) {
                    onDelete(active.id);
                    startNew();
                  }
                }}
              >
                <TrashIcon width={16} height={16} />
              </button>
            )}
          </div>
        </header>

        <Messages thread={active} onCite={onCite} onRetry={() => onRetry(active)} />

        <Composer
          busy={active.busy}
          mode={mode}
          checkedCount={checkedCount}
          totalCount={totalCount}
          onGoLibrary={onGoLibrary}
          onSend={send}
          focusKey={active.id}
          media={generalAvailable}
          pasteScope={viewRef}
        />
      </section>
    </div>
  );
}

function Messages({ thread, onCite, onRetry }: { thread: Thread; onCite: (c: Citation) => void; onRetry: () => void }) {
  const endRef = useRef<HTMLDivElement>(null);
  const last = thread.turns[thread.turns.length - 1];
  const lastLen = last?.role === "assistant" ? last.body.length : 0;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [thread.id, thread.turns.length, lastLen]);

  if (!thread.turns.length)
    return (
      <div className="flex flex-1 flex-col justify-center py-10 text-center">
        <p className="font-display text-2xl">What do you want to understand?</p>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted">
          {thread.mode === "general"
            ? "Ask anything: explanations, worked examples, how to approach a question. Answers come from general knowledge, not your sources."
            : "Answers come only from the sources you've checked in the Library, with numbered links to the exact passage."}
        </p>
      </div>
    );

  return (
    <div className="mx-auto w-full max-w-[46rem] flex-1 py-6">
      {thread.turns.map((turn, i) =>
        turn.role === "user" ? (
          <div key={i} className={`flex flex-col items-end gap-2 ${i ? "mt-10" : ""}`}>
            {!!turn.images?.length && (
              <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
                {turn.images.map((im) =>
                  im.thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={im.id} src={im.thumb} alt="Photo attached to this question" className="h-20 w-auto max-w-[10rem] rounded border border-line object-cover" />
                  ) : (
                    <span key={im.id} className="grid h-20 w-20 place-items-center rounded border border-line bg-sunken text-xs text-muted">
                      Photo
                    </span>
                  ),
                )}
              </div>
            )}
            <p className="max-w-[85%] whitespace-pre-wrap break-words rounded border border-line bg-sunken px-4 py-2.5 text-[0.95rem] leading-relaxed">
              {turn.text}
            </p>
          </div>
        ) : (
          <div key={i} className="mt-6">
            <AnswerBody
              body={turn.body}
              citations={turn.citations}
              onCite={onCite}
              streaming={thread.busy && i === thread.turns.length - 1}
              variant="chat"
            />
            {turn.error && (
              <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-danger">
                {turn.error}
                {i === thread.turns.length - 1 && !thread.busy && <RetryLink onRetry={onRetry} />}
              </p>
            )}
          </div>
        ),
      )}
      <div ref={endRef} />
    </div>
  );
}

type Pending = { file: File; url: string };

function Composer({
  busy,
  mode,
  checkedCount,
  totalCount,
  onGoLibrary,
  onSend,
  focusKey,
  media,
  pasteScope,
}: {
  busy: boolean;
  mode: AskMode;
  checkedCount: number;
  totalCount: number;
  onGoLibrary: () => void;
  onSend: (text: string, images?: AskImage[]) => void;
  focusKey: string;
  /** Photos and voice need the on-device engine. */
  media: boolean;
  /** Pasting an image anywhere in this element attaches it. */
  pasteScope: RefObject<HTMLElement | null>;
}) {
  const [text, setText] = useState("");
  const [photos, setPhotos] = useState<Pending[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (window.matchMedia("(min-width: 1024px)").matches) ref.current?.focus();
  }, [focusKey]);

  // ---- photos ----
  const addFiles = async (files: File[]) => {
    const room = MAX_PHOTOS - photos.length;
    if (room <= 0) return setError(`Up to ${MAX_PHOTOS} photos per question.`);
    setError(null);
    const small = await Promise.all(files.slice(0, room).map(shrink));
    setPhotos((p) => [...p, ...small.map((file) => ({ file, url: URL.createObjectURL(file) }))].slice(0, MAX_PHOTOS));
  };
  const removePhoto = (i: number) =>
    setPhotos((p) => {
      URL.revokeObjectURL(p[i].url);
      return p.filter((_, j) => j !== i);
    });
  const pickPhoto = async () => {
    if (!isNative()) return fileRef.current?.click();
    const photo = await nativePhoto(); // the system camera / gallery sheet, one photo per tap
    if (photo) await addFiles([photo]);
  };

  // ---- voice ----
  const recRef = useRef<MediaRecorder | null>(null);
  const [recording, setRecording] = useState(false);
  usePasteImages(pasteScope, (files) => void addFiles(files), media && !recording);
  const [seconds, setSeconds] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const lastVoice = useRef<Blob | null>(null);
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);
  const stopRec = () => {
    if (recRef.current?.state === "recording") recRef.current.stop();
    setRecording(false);
  };
  useEffect(() => {
    if (recording && seconds >= MAX_VOICE_SECONDS) stopRec();
  }, [recording, seconds]);
  // Leaving the screen mid-recording releases the microphone.
  useEffect(
    () => () => {
      const rec = recRef.current;
      if (rec && rec.state === "recording") {
        rec.onstop = null;
        rec.stop();
        rec.stream.getTracks().forEach((t) => t.stop());
      }
    },
    [],
  );

  const transcribe = async (blob: Blob) => {
    lastVoice.current = blob;
    setTranscribing(true);
    setError(null);
    try {
      const said = await api.transcribeVoice(blob);
      lastVoice.current = null;
      // Into the box for the student to check and edit: never sent by itself.
      setText((t) => (t.trim() ? `${t.trim()} ${said}` : said));
      requestAnimationFrame(() => ref.current?.focus());
    } catch (e) {
      setError((e as Error).message || "Couldn't transcribe that recording.");
    } finally {
      setTranscribing(false);
    }
  };
  const startRec = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const parts: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        void transcribe(new Blob(parts, { type: rec.mimeType || "audio/webm" }));
      };
      rec.start(1000);
      recRef.current = rec;
      setSeconds(0);
      setRecording(true);
    } catch {
      setError("Couldn't use the microphone. Check the permission for this app or site.");
    }
  };
  const mmss = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

  const noSources = mode === "sources" && checkedCount === 0;
  const canSend = (!!text.trim() || photos.length > 0) && !busy && !noSources && !sending && !recording && !transcribing;
  const submit = async () => {
    if (!canSend) return;
    const t = text.trim() || "Help me with the attached photo.";
    let images: AskImage[] | undefined;
    if (photos.length) {
      setSending(true);
      try {
        images = await api.saveAskImages(photos.map((p) => p.file));
      } catch (e) {
        setError((e as Error).message || "Couldn't save the photos.");
        setSending(false);
        return;
      }
      setSending(false);
    }
    onSend(t, images);
    setText("");
    photos.forEach((p) => URL.revokeObjectURL(p.url));
    setPhotos([]);
    if (ref.current) ref.current.style.height = "auto";
  };
  const iconBtn = "grid h-10 w-10 shrink-0 place-items-center rounded border border-line text-muted transition-colors hover:text-ink disabled:opacity-40";
  return (
    <div className="sticky bottom-0 mx-auto w-full max-w-[46rem] bg-paper px-1 pb-4 pt-2">
      <p className="mb-1.5 flex items-center gap-1.5 px-1 text-xs text-muted">
        <span className={`h-1.5 w-1.5 rounded-full ${mode === "general" ? "bg-muted" : noSources ? "bg-danger" : "bg-moss"}`} />
        {mode === "general" ? (
          "General knowledge, not from your sources: double-check against your notes."
        ) : noSources ? (
          <>
            No sources checked.{" "}
            <button type="button" onClick={onGoLibrary} className="text-accent underline underline-offset-2">
              Check some in the Library
            </button>
          </>
        ) : (
          `From ${checkedCount} of ${totalCount} source${totalCount === 1 ? "" : "s"}`
        )}
        {media && <span className="ml-auto">or paste a screenshot</span>}
      </p>
      <div className="rounded border border-line bg-card p-2">
        {photos.length > 0 && (
          <ul className="mb-2 flex flex-wrap gap-2 px-1 pt-1.5">
            {photos.map((p, i) => (
              <li key={p.url} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.url} alt={`Attached photo ${i + 1}`} className="h-16 w-16 rounded border border-line object-cover" />
                <button
                  type="button"
                  onClick={() => removePhoto(i)}
                  aria-label={`Remove photo ${i + 1}`}
                  className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded border border-line bg-card text-muted hover:text-danger"
                >
                  <CloseIcon width={12} height={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {(recording || transcribing) && (
          <p className="mb-2 flex items-center gap-2 px-2 text-sm" role="status">
            {recording ? (
              <>
                <span aria-hidden className="h-2 w-2 animate-pulse rounded-sm bg-danger" />
                <span className="tabular-nums">Recording {mmss}</span>
                <span className="text-xs text-muted">of {Math.floor(MAX_VOICE_SECONDS / 60)}:00</span>
                <button type="button" onClick={stopRec} className="ml-auto rounded border border-danger px-3 py-1 text-danger">
                  Stop
                </button>
              </>
            ) : (
              <span className="text-muted">Turning your voice into text…</span>
            )}
          </p>
        )}
        <div className="flex items-end gap-2">
          {media && (
            <>
              <button type="button" onClick={pickPhoto} disabled={photos.length >= MAX_PHOTOS || recording} aria-label="Add photo" title="Add photo (camera or gallery)" className={iconBtn}>
                <CameraIcon width={18} height={18} />
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  if (files.length) void addFiles(files);
                }}
              />
              <button
                type="button"
                onClick={() => (recording ? stopRec() : startRec())}
                disabled={transcribing}
                aria-label={recording ? "Stop recording" : "Ask by voice"}
                title={recording ? "Stop recording" : "Ask by voice"}
                className={`${iconBtn} ${recording ? "!border-danger !text-danger" : ""}`}
              >
                <MicIcon width={18} height={18} />
              </button>
            </>
          )}
          <textarea
            ref={ref}
            rows={1}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder={mode === "general" ? "Ask anything…" : "Ask about your sources…"}
            className="max-h-[180px] min-h-[40px] min-w-0 flex-1 resize-none bg-transparent px-2 py-2 outline-none placeholder:text-muted"
          />
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSend}
            aria-label="Send"
            className="grid h-10 w-10 shrink-0 place-items-center rounded bg-accent text-on-accent transition-opacity disabled:opacity-40"
          >
            <ArrowUpIcon width={18} height={18} />
          </button>
        </div>
      </div>
      {error && <ErrorNote text={error} onClose={() => setError(null)} onRetry={lastVoice.current ? () => void transcribe(lastVoice.current!) : undefined} />}
    </div>
  );
}
