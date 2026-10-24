"use client";

import { useEffect, useRef } from "react";
import type { Citation } from "@/lib/api";
import type { Thread } from "@/lib/threads";
import AnswerBody from "./AnswerBody";
import { RetryLink } from "./study/shared";
import { CloseIcon } from "./icons";

/** Answers to command-bar requests made outside Read mode rise as a sheet over the current screen. */
export default function ResponseSheet({
  thread,
  onCite,
  onClose,
  onClear,
  onRetry,
}: {
  thread: Thread;
  onCite: (c: Citation) => void;
  onClose: () => void;
  onClear: () => void;
  onRetry?: () => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const last = thread.turns[thread.turns.length - 1];
  const lastLen = last?.role === "assistant" ? last.body.length : 0;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [thread.turns.length, lastLen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="absolute inset-x-0 bottom-0 z-30 flex justify-center px-3">
      <div className="sheet-rise mb-[118px] flex max-h-[62vh] w-full max-w-[720px] flex-col rounded-[22px] border border-line bg-card shadow-[0_20px_60px_-20px_rgba(40,30,20,.45)]">
        <div className="flex items-center justify-between border-b border-line px-5 py-2.5 text-xs uppercase tracking-[0.16em] text-muted">
          <span>From your sources</span>
          <span className="flex items-center gap-3">
            <button type="button" onClick={onClear} className="normal-case tracking-normal hover:text-ink">
              Clear
            </button>
            <button type="button" onClick={onClose} title="Hide (Esc)" className="hover:text-ink">
              <CloseIcon width={16} height={16} />
            </button>
          </span>
        </div>
        <div className="overflow-y-auto px-5 py-4">
          {thread.turns.map((turn, i) =>
            turn.role === "user" ? (
              <p key={i} className={`font-display text-xl leading-snug ${i ? "mt-6 border-t border-line pt-5" : ""}`}>
                {turn.text}
              </p>
            ) : (
              <div key={i} className="mt-2">
                <AnswerBody
                  body={turn.body}
                  citations={turn.citations}
                  onCite={onCite}
                  streaming={thread.busy && i === thread.turns.length - 1}
                />
                {turn.error && (
                  <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-danger">
                    {turn.error}
                    {onRetry && i === thread.turns.length - 1 && !thread.busy && <RetryLink onRetry={onRetry} />}
                  </p>
                )}
                {turn.citations.length > 0 && !thread.busy && (
                  <p className="mt-3 text-xs text-muted">Tap a number to open the passage in Read.</p>
                )}
              </div>
            ),
          )}
          <div ref={endRef} />
        </div>
      </div>
    </div>
  );
}
