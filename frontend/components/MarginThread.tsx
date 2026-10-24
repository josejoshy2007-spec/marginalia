"use client";

import { useEffect, useRef, useState } from "react";
import type { Citation } from "@/lib/api";
import { forRetry, type Thread } from "@/lib/threads";
import AnswerBody from "./AnswerBody";
import { RetryLink } from "./study/shared";
import { ArrowUpIcon, CloseIcon } from "./icons";

type Props = {
  thread: Thread;
  active: boolean;
  onActivate: () => void;
  onAsk: (t: Thread, message: string) => void;
  onDiscard: (id: string) => void;
  onCite: (c: Citation) => void;
};

export default function MarginThread({ thread, active, onActivate, onAsk, onDiscard, onCite }: Props) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fresh = thread.turns.length === 0;

  useEffect(() => {
    if (fresh) inputRef.current?.focus();
  }, [fresh]);

  const submit = () => {
    const q = draft.trim();
    if (!q || thread.busy) return;
    setDraft("");
    onAsk(thread, q);
  };

  return (
    <div
      onMouseDown={onActivate}
      className={`margin-card rounded-xl border bg-card text-sm shadow-sm transition-shadow ${
        active ? "border-accent/50 shadow-md" : "border-line"
      }`}
    >
      <div className="flex items-start gap-2 border-b border-line/70 px-3 py-2">
        <p className="line-clamp-2 flex-1 font-reading text-[0.82rem] italic leading-snug text-muted">
          {thread.anchor ? `“${thread.anchor.text}”` : "On the whole source"}
        </p>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDiscard(thread.id);
          }}
          title="Close thread"
          className="mt-0.5 text-muted hover:text-ink"
        >
          <CloseIcon width={14} height={14} />
        </button>
      </div>

      {thread.turns.length > 0 && (
        <div className="space-y-3 px-3 py-3">
          {thread.turns.map((turn, i) =>
            turn.role === "user" ? (
              <p key={i} className="font-medium text-ink">
                {turn.text}
              </p>
            ) : (
              <div key={i}>
                <AnswerBody
                  body={turn.body}
                  citations={turn.citations}
                  onCite={onCite}
                  streaming={thread.busy && i === thread.turns.length - 1}
                />
                {turn.error && (
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-danger">
                    {turn.error}
                    {i === thread.turns.length - 1 && !thread.busy && (
                      <RetryLink
                        onRetry={() => {
                          const r = forRetry(thread);
                          if (r) onAsk(r.trimmed, r.question);
                        }}
                      />
                    )}
                  </p>
                )}
              </div>
            ),
          )}
        </div>
      )}

      <form
        className="flex items-end gap-2 px-3 pb-3 pt-1"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={inputRef}
          value={draft}
          rows={1}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape" && fresh) onDiscard(thread.id);
          }}
          placeholder={fresh ? "What's unclear here?" : "Follow up…"}
          className="max-h-32 min-h-[34px] flex-1 resize-none rounded-lg bg-sunken px-2.5 py-1.5 text-sm outline-none placeholder:text-muted focus:ring-1 focus:ring-accent/50"
        />
        <button
          type="submit"
          disabled={!draft.trim() || thread.busy}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-ink text-paper disabled:opacity-30"
          title="Ask"
        >
          <ArrowUpIcon width={15} height={15} />
        </button>
      </form>
    </div>
  );
}
