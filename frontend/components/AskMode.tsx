"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Citation } from "@/lib/api";
import { askConfirm } from "@/lib/confirm";
import { newThreadId, threadTitle, type Thread } from "@/lib/threads";
import AnswerBody from "./AnswerBody";
import { ArrowUpIcon, PlusIcon, TrashIcon } from "./icons";
import { RetryLink, Segmented } from "./study/shared";

type AskMode = "sources" | "general";

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
 * through Google Drive. The bottom bar's quick answers appear here too.
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
  onAsk: (thread: Thread, message: string) => void;
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

  const send = (text: string) => {
    if (isDraft) {
      setDraft(newDraft(active.mode ?? "sources")); // the sent draft becomes a saved conversation
      setActiveId(active.id);
    }
    onAsk(active, text);
  };

  const mode: AskMode = active.mode ?? "sources";
  return (
    <div className="mx-auto flex h-full max-w-6xl gap-8 px-4 pt-6 sm:px-8">
      <aside className={`${showList ? "flex" : "hidden"} min-w-0 flex-1 flex-col lg:flex lg:w-72 lg:flex-none`}>
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-[0.18em] text-muted">Ask AI</p>
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
                  t.id === active.id ? "bg-card shadow-sm ring-1 ring-line" : "hover:bg-card/60"
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
    <div className="flex-1 py-5">
      {thread.turns.map((turn, i) =>
        turn.role === "user" ? (
          <p key={i} className={`font-display text-xl leading-snug ${i ? "mt-7 border-t border-line pt-6" : ""}`}>
            {turn.text}
          </p>
        ) : (
          <div key={i} className="mt-2 leading-relaxed">
            <AnswerBody body={turn.body} citations={turn.citations} onCite={onCite} streaming={thread.busy && i === thread.turns.length - 1} />
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

function Composer({
  busy,
  mode,
  checkedCount,
  totalCount,
  onGoLibrary,
  onSend,
  focusKey,
}: {
  busy: boolean;
  mode: AskMode;
  checkedCount: number;
  totalCount: number;
  onGoLibrary: () => void;
  onSend: (text: string) => void;
  focusKey: string;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (window.matchMedia("(min-width: 1024px)").matches) ref.current?.focus();
  }, [focusKey]);
  const noSources = mode === "sources" && checkedCount === 0;
  const submit = () => {
    const t = text.trim();
    if (!t || busy || noSources) return;
    onSend(t);
    setText("");
  };
  return (
    <div className="sticky bottom-0 -mx-1 bg-paper px-1 pb-4 pt-2">
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
      </p>
      <div className="flex items-end gap-2 rounded-[22px] border border-line bg-card p-2 shadow-[0_8px_30px_-18px_rgba(40,30,20,.5)]">
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
              submit();
            }
          }}
          placeholder={mode === "general" ? "Ask anything…" : "Ask about your sources…"}
          className="max-h-[180px] min-h-[40px] flex-1 resize-none bg-transparent px-3 py-2 outline-none placeholder:text-muted"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!text.trim() || busy || noSources}
          aria-label="Send"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-accent text-paper transition-opacity disabled:opacity-40"
        >
          <ArrowUpIcon width={18} height={18} />
        </button>
      </div>
    </div>
  );
}
