"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpIcon, CloseIcon } from "./icons";

const MAKERS = [
  { label: "Summarize", prompt: "Summarize the key ideas, one short paragraph per idea." },
  { label: "Quiz me", prompt: "Make 5 multiple-choice questions to test me, with answers and explanations at the end." },
  { label: "Key terms", prompt: "List the key terms with a one-line definition each." },
  { label: "Explain simply", prompt: "Explain the core concept as if I'm seeing it for the first time." },
];

type Props = {
  disabled: boolean;
  busy: boolean;
  checkedCount: number;
  totalCount: number;
  focusLabel: string | null;
  onClearFocus?: () => void;
  canReopen: boolean;
  onReopen: () => void;
  onSubmit: (message: string) => void;
};

export default function CommandBar(p: Props) {
  const [value, setValue] = useState("");
  const [showMakers, setShowMakers] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  // "/" focuses the bar from anywhere that isn't already a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const send = (text: string) => {
    const q = text.trim();
    if (!q || p.disabled || p.busy) return;
    p.onSubmit(q);
    setValue("");
    setShowMakers(false);
  };

  const scope =
    p.totalCount === 0
      ? "No sources yet"
      : p.checkedCount === p.totalCount
        ? `All ${p.totalCount} source${p.totalCount === 1 ? "" : "s"}`
        : `${p.checkedCount} of ${p.totalCount} sources`;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-40 flex justify-center px-3 pb-4 sm:pb-6">
      <div className="pointer-events-auto w-full max-w-[720px]">
        {showMakers && (
          <div className="mb-2 flex flex-wrap gap-2">
            {MAKERS.map((m) => (
              <button
                key={m.label}
                type="button"
                onClick={() => send(m.prompt)}
                className="rounded-full border border-line bg-card px-3 py-1 text-sm shadow-sm hover:border-accent hover:text-accent"
              >
                {m.label}
              </button>
            ))}
          </div>
        )}
        <div className="command-bar rounded-[22px] border border-line bg-card/95 p-2 shadow-[0_10px_40px_-12px_rgba(40,30,20,.35)] backdrop-blur">
          <div className="flex items-center gap-2 px-2 pb-1 text-[11px] text-muted">
            <span className="inline-flex items-center gap-1">
              <span className={`h-1.5 w-1.5 rounded-full ${p.checkedCount ? "bg-moss" : "bg-danger"}`} />
              {scope}
            </span>
            {p.focusLabel && (
              <span className="inline-flex min-w-0 items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-accent">
                <span className="truncate">{p.focusLabel}</span>
                {p.onClearFocus && (
                  <button type="button" onClick={p.onClearFocus} title="Ask about the whole source instead">
                    <CloseIcon width={11} height={11} />
                  </button>
                )}
              </span>
            )}
            {p.canReopen && (
              <button type="button" onClick={p.onReopen} className="ml-auto underline underline-offset-2 hover:text-ink">
                show last answer
              </button>
            )}
          </div>
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              send(value);
            }}
          >
            <button
              type="button"
              onClick={() => setShowMakers((s) => !s)}
              className={`mb-0.5 shrink-0 rounded-full px-3 py-1.5 text-sm transition-colors ${
                showMakers ? "bg-ink text-paper" : "bg-sunken text-ink hover:bg-line"
              }`}
              title="Quick generation requests"
            >
              Make
            </button>
            <textarea
              ref={ref}
              value={value}
              rows={1}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(value);
                }
              }}
              placeholder="Ask or make…"
              aria-label="Ask or make"
              className="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent px-1 py-2 text-[0.98rem] outline-none placeholder:text-muted"
            />
            <button
              type="submit"
              disabled={!value.trim() || p.busy || p.disabled}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-accent text-white transition-opacity disabled:opacity-30"
              title="Send (Enter)"
            >
              {p.busy ? <span className="h-3 w-3 animate-ping rounded-full bg-white" /> : <ArrowUpIcon width={18} height={18} />}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
