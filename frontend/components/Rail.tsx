"use client";

import { CondenseIcon, DialIcon, LensIcon, ShelfIcon, TargetIcon, WaveIcon } from "./icons";

export type Mode = "library" | "read" | "summarise" | "practice" | "listen";

const MODES: { id: Mode; label: string; Icon: typeof ShelfIcon; key: string }[] = [
  { id: "library", label: "Library", Icon: ShelfIcon, key: "1" },
  { id: "read", label: "Read", Icon: LensIcon, key: "2" },
  { id: "summarise", label: "Summarise", Icon: CondenseIcon, key: "3" },
  { id: "practice", label: "Practice", Icon: TargetIcon, key: "4" },
  { id: "listen", label: "Listen", Icon: WaveIcon, key: "5" },
];

export default function Rail({
  mode,
  onMode,
  subjectName,
  onSettings,
}: {
  mode: Mode;
  onMode: (m: Mode) => void;
  subjectName?: string;
  onSettings?: () => void;
}) {
  return (
    <nav
      aria-label="Modes"
      className="flex w-[68px] shrink-0 flex-col items-center gap-1 border-r border-line bg-rail py-4"
    >
      <div
        className="mb-5 grid h-9 w-9 place-items-center rounded-full bg-ink font-display text-lg italic text-paper"
        title="Marginalia"
      >
        m
      </div>
      {MODES.map(({ id, label, Icon, key }) => {
        const active = mode === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onMode(id)}
            aria-current={active ? "page" : undefined}
            title={`${label} (Alt+${key})`}
            className={`group relative flex w-14 flex-col items-center gap-1 rounded-xl py-2 text-[10.5px] font-medium tracking-wide transition-colors ${
              active ? "text-ink" : "text-muted hover:text-ink"
            }`}
          >
            <span
              className={`absolute left-[-7px] top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r-full transition-all ${
                active ? "bg-accent opacity-100" : "opacity-0"
              }`}
            />
            <span
              className={`grid h-9 w-9 place-items-center rounded-xl transition-colors ${
                active ? "bg-card shadow-sm ring-1 ring-line" : "group-hover:bg-card/60"
              }`}
            >
              <Icon />
            </span>
            {label}
          </button>
        );
      })}
      {onSettings && (
        <button
          type="button"
          onClick={onSettings}
          title="Settings"
          aria-label="Settings"
          className="mt-auto grid h-9 w-9 place-items-center rounded-xl text-muted transition-colors hover:bg-card/60 hover:text-ink"
        >
          <DialIcon />
        </button>
      )}
      {subjectName && (
        <div
          className={`${onSettings ? "mt-3" : "mt-auto"} w-14 truncate px-1 text-center text-[10px] uppercase tracking-[0.12em] text-muted [writing-mode:vertical-rl] rotate-180 max-h-48`}
          title={subjectName}
        >
          {subjectName}
        </div>
      )}
    </nav>
  );
}
