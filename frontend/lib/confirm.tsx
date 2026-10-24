"use client";

import { useEffect, useRef, useState } from "react";

/**
 * In-app confirmation dialog. Use instead of window.confirm(): embedded browsers (e.g. the Claude
 * desktop app's browser pane) suppress native dialogs and confirm() silently returns false, which
 * made every delete button do nothing.
 */
type Options = { detail?: string; confirmLabel?: string; danger?: boolean };
type Request = Options & { message: string; resolve: (ok: boolean) => void };

let show: ((r: Request) => void) | null = null;

export function askConfirm(message: string, opts: Options = {}): Promise<boolean> {
  return new Promise((resolve) => {
    if (!show) return resolve(false);
    show({ message, confirmLabel: "Delete", danger: true, ...opts, resolve });
  });
}

/** Mount once (in App). Renders the dialog when askConfirm() is called. */
export function ConfirmHost() {
  const [req, setReq] = useState<Request | null>(null);
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    show = (r) => setReq(r);
    return () => {
      show = null;
    };
  }, []);

  useEffect(() => {
    if (!req) return;
    okRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req]);

  const close = (ok: boolean) => {
    req?.resolve(ok);
    setReq(null);
  };

  if (!req) return null;
  return (
    <div
      className="safe-overlay fixed inset-0 z-[100] grid place-items-center bg-ink/30 px-4 backdrop-blur-[2px]"
      onMouseDown={(e) => e.target === e.currentTarget && close(false)}
    >
      <div role="alertdialog" aria-modal="true" aria-label={req.message} className="sheet-rise w-full max-w-sm rounded-2xl border border-line bg-card p-5 shadow-xl">
        <p className="font-display text-xl leading-snug">{req.message}</p>
        {req.detail && <p className="mt-2 text-sm text-muted">{req.detail}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={() => close(false)}>
            Cancel
          </button>
          <button
            ref={okRef}
            type="button"
            onClick={() => close(true)}
            className={`rounded-full px-4 py-2 text-sm font-medium text-white ${req.danger ? "bg-danger" : "bg-ink"}`}
          >
            {req.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
