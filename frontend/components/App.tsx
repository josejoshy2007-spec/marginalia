"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ENGINE, streamChat, type Citation, type Source, type Subject } from "@/lib/api";
import { getSettings } from "@/lib/local/settings";
import { localApi } from "@/lib/local/store";
import { scheduleReminder } from "@/lib/native";
import SettingsSheet from "./SettingsSheet";
import { useSyncStatus } from "./DriveSync";
import { startAutoSync } from "@/lib/local/sync";
import { addCitations, forRetry, newThreadId, stripCites, threadTitle, type Anchor, type Thread, type Turn } from "@/lib/threads";
import Rail, { MODES, type Mode } from "./Rail";
import AskMode from "./AskMode";
import LibraryMode from "./LibraryMode";
import ReadMode from "./ReadMode";
import CommandBar from "./CommandBar";
import ResponseSheet from "./ResponseSheet";
import PracticeMode from "./PracticeMode";
import ListenMode from "./ListenMode";
import { ConfirmHost } from "@/lib/confirm";
import SummariseMode from "./SummariseMode";

export type Focus = { sourceId: number; start: number; end: number; nonce: number };

const LS_SUBJECT = "marginalia.subject";

export default function App() {
  const [mode, setMode] = useState<Mode>("library");
  const [subjects, setSubjects] = useState<Subject[] | null>(null);
  const [subjectId, setSubjectId] = useState<number | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [readSourceId, setReadSourceId] = useState<number | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [askActiveId, setAskActiveId] = useState<string | null>(null);
  // Conversations are saved per subject: what's been saved (by content), and for which subject.
  const saved = useRef(new Map<string, string>());
  const threadsSubject = useRef<number | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const aborters = useRef(new Map<string, AbortController>());
  // On-device version: settings overlay (opens by itself until a Gemini key is saved).
  const [settings, setSettings] = useState<null | "first" | "open">(null);
  useEffect(() => {
    if (ENGINE !== "local") return;
    getSettings().then(async (s) => {
      if (!s.geminiKey) setSettings("first");
      scheduleReminder(s.remindersOn, s.reminderHour, await localApi.dueCards());
    });
    startAutoSync();
  }, []);
  const sync = useSyncStatus();

  // ---- data loading ----
  const refreshSubjects = useCallback(async () => {
    try {
      const list = await api.subjects();
      setSubjects(list);
      setLoadError(null);
      return list;
    } catch (e) {
      setLoadError(
        ENGINE === "local"
          ? `Couldn't open the library on this device (${(e as Error).message}).`
          : `Can't reach the API (${(e as Error).message}). Is the backend running?`,
      );
      setSubjects([]);
      return [];
    }
  }, []);

  useEffect(() => {
    refreshSubjects().then((list) => {
      let saved: number | null = null;
      try {
        saved = Number(localStorage.getItem(LS_SUBJECT)) || null;
      } catch {}
      const pick = list.find((s) => s.id === saved) ?? list[0];
      if (pick) setSubjectId(pick.id);
    });
  }, [refreshSubjects]);

  const refreshSources = useCallback(async () => {
    if (subjectId == null) return setSources([]);
    const list = await api.sources(subjectId);
    setSources(list);
    return list;
  }, [subjectId]);

  // Drive sync brought in changes from another device: reload the shelf.
  useEffect(() => {
    const onChange = async () => {
      const list = await refreshSubjects();
      if (subjectId != null && !list.some((x) => x.id === subjectId)) setSubjectId(list[0]?.id ?? null);
      else {
        refreshSources();
        if (subjectId != null) {
          // Bring in conversations from other devices, keeping anything still being answered here.
          const fresh = await api.threads(subjectId);
          for (const t of fresh) saved.current.set(t.id, signature(t));
          setThreads((ts) => {
            const local = ts.filter((t) => t.busy || !t.turns.length);
            return [...fresh.filter((f) => !local.some((l) => l.id === f.id)), ...local];
          });
        }
      }
    };
    window.addEventListener("marginalia:library-changed", onChange);
    return () => window.removeEventListener("marginalia:library-changed", onChange);
  }, [refreshSubjects, refreshSources, subjectId]);

  useEffect(() => {
    if (subjectId == null) return;
    try {
      localStorage.setItem(LS_SUBJECT, String(subjectId));
    } catch {}
    // Switching subjects swaps conversations; they're saved per subject, not thrown away.
    setThreads([]);
    setActiveThreadId(null);
    setAskActiveId(null);
    setSheetOpen(false);
    setReadSourceId(null);
    refreshSources();
    threadsSubject.current = null;
    let stale = false;
    api.threads(subjectId).then((ts) => {
      if (stale) return;
      saved.current = new Map(ts.map((t) => [t.id, signature(t)]));
      threadsSubject.current = subjectId;
      setThreads(ts);
    });
    return () => {
      stale = true;
    };
  }, [subjectId, refreshSources]);

  // Save conversations whose content changed (a mode switch, a cleared or retried answer…).
  // Answers themselves are saved by ask() when they finish, even after a subject switch.
  useEffect(() => {
    const sid = threadsSubject.current;
    if (sid == null) return;
    for (const t of threads) {
      if (t.busy || !t.turns.length) continue;
      const sig = signature(t);
      if (saved.current.get(t.id) === sig) continue;
      saved.current.set(t.id, sig);
      api.saveThread(sid, t).catch(() => saved.current.delete(t.id));
    }
  }, [threads]);

  // Alt+1..6 switches modes (each mode's key is shown in the rail).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const hit = e.altKey ? MODES.find((m) => m.key === e.key) : undefined;
      if (hit) {
        e.preventDefault();
        setMode(hit.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // While a recording is being transcribed, poll so the progress bar moves and it turns "ready".
  const transcribing = sources.some((s) => s.status === "processing");
  useEffect(() => {
    if (!transcribing) return;
    const t = setInterval(() => refreshSources(), 3000);
    return () => clearInterval(t);
  }, [transcribing, refreshSources]);

  const checkedIds = useMemo(
    () => sources.filter((s) => s.checked && s.status === "ready").map((s) => s.id),
    [sources],
  );

  // ---- threads ----
  const patchThread = useCallback((id: string, fn: (t: Thread) => Thread) => {
    setThreads((ts) => ts.map((t) => (t.id === id ? fn(t) : t)));
  }, []);

  const patchLastTurn = useCallback(
    (id: string, fn: (t: Extract<Turn, { role: "assistant" }>) => Turn) =>
      patchThread(id, (t) => {
        const turns = [...t.turns];
        const last = turns[turns.length - 1];
        if (last?.role === "assistant") turns[turns.length - 1] = fn(last);
        return { ...t, turns };
      }),
    [patchThread],
  );

  const ask = useCallback(
    async (thread: Thread, message: string) => {
      if (subjectId == null || thread.busy) return;
      const sid = subjectId;
      const general = thread.mode === "general";
      const history = thread.turns.map((t) =>
        t.role === "user"
          ? { role: "user" as const, content: t.text }
          : { role: "assistant" as const, content: stripCites(t.body) },
      );
      const selection =
        thread.kind === "margin" && thread.anchor && thread.sourceId != null
          ? { source_id: thread.sourceId, ...thread.anchor }
          : null;

      const stamp = new Date().toISOString();
      // `cur` mirrors the thread as it streams, so the finished answer is saved even if the student
      // has switched subject (and this thread has left the screen) in the meantime.
      let cur: Thread = {
        ...thread,
        busy: true,
        createdAt: thread.createdAt ?? stamp,
        updatedAt: stamp,
        turns: [...thread.turns, { role: "user", text: message }, { role: "assistant", body: "", citations: [] }],
      };
      if (thread.kind === "ask" && !thread.title) cur = { ...cur, title: threadTitle(cur) };
      setThreads((ts) => (ts.some((t) => t.id === thread.id) ? ts.map((t) => (t.id === thread.id ? cur : t)) : [...ts, cur]));
      const lastTurn = (fn: (t: Extract<Turn, { role: "assistant" }>) => Turn) => {
        const turns = [...cur.turns];
        const last = turns[turns.length - 1];
        if (last?.role === "assistant") turns[turns.length - 1] = fn(last);
        cur = { ...cur, turns };
        patchLastTurn(thread.id, fn);
      };

      const ctrl = new AbortController();
      aborters.current.set(thread.id, ctrl);
      try {
        await streamChat(
          sid,
          {
            message,
            source_ids: general ? [] : checkedIds,
            selection: general ? null : selection,
            history,
            mode: general ? "general" : "sources",
          },
          (e) => {
            if (e.type === "text") lastTurn((t) => ({ ...t, body: t.body + e.text }));
            else if (e.type === "cite")
              lastTurn((t) => {
                const { citations, tokens } = addCitations(t.citations, e.citations);
                return { ...t, citations, body: t.body + tokens };
              });
            else if (e.type === "error") lastTurn((t) => ({ ...t, error: e.message }));
          },
          ctrl.signal,
        );
      } catch (err) {
        if ((err as Error).name !== "AbortError") lastTurn((t) => ({ ...t, error: (err as Error).message || "Request failed" }));
      } finally {
        aborters.current.delete(thread.id);
        cur = { ...cur, busy: false };
        patchThread(thread.id, (t) => ({ ...t, busy: false }));
        if (!ctrl.signal.aborted) {
          saved.current.set(cur.id, signature(cur));
          api.saveThread(sid, cur).catch(() => saved.current.delete(cur.id));
        }
      }
    },
    [subjectId, checkedIds, patchLastTurn, patchThread],
  );

  const discardThread = useCallback((id: string) => {
    aborters.current.get(id)?.abort();
    saved.current.delete(id);
    api.deleteThread(id).catch(() => {});
    setThreads((ts) => ts.filter((t) => t.id !== id));
    setActiveThreadId((a) => (a === id ? null : a));
  }, []);

  /** Text selected in Read mode: replace any untouched draft with a fresh anchored margin thread. */
  const openMarginThread = useCallback(
    (sourceId: number, anchor: Anchor) => {
      const t: Thread = { id: newThreadId(), kind: "margin", sourceId, anchor, turns: [], busy: false };
      setThreads((ts) => [...ts.filter((x) => x.turns.length > 0), t]);
      setActiveThreadId(t.id);
    },
    [],
  );

  const onCite = useCallback((c: Citation) => {
    setReadSourceId(c.source_id);
    setMode("read");
    setSheetOpen(false);
    setFocus({ sourceId: c.source_id, start: c.start, end: c.end, nonce: Date.now() });
  }, []);

  const openInReader = useCallback((sourceId: number) => {
    setReadSourceId(sourceId);
    setMode("read");
  }, []);

  // ---- command bar ----
  const activeThread = threads.find((t) => t.id === activeThreadId) ?? null;
  const readerTarget =
    mode === "read" && activeThread?.kind === "margin" && activeThread.sourceId === readSourceId ? activeThread : null;

  const submitCommand = (message: string) => {
    if (mode === "read" && readSourceId != null) {
      const target: Thread =
        readerTarget && !readerTarget.busy
          ? readerTarget
          : { id: newThreadId(), kind: "margin", sourceId: readSourceId, anchor: null, turns: [], busy: false };
      setActiveThreadId(target.id);
      ask(target, message);
      return;
    }
    const sheet: Thread = threads.find((t) => t.kind === "sheet") ?? {
      id: newThreadId(),
      kind: "sheet",
      turns: [],
      busy: false,
    };
    setSheetOpen(true);
    ask(sheet, message);
  };

  const subject = subjects?.find((s) => s.id === subjectId) ?? null;
  const studyProps = (id: number) => ({
    subjectId: id,
    checkedIds,
    totalSources: sources.length,
    onCite,
    onGoLibrary: () => setMode("library"),
    sources,
    onSourcesChanged: refreshSources,
    ibLabel: subject?.ib_course ? `IB ${subject.ib_course}${subject.ib_level ? ` ${subject.ib_level}` : ""}` : null,
  });
  const sheetThread = threads.find((t) => t.kind === "sheet") ?? null;
  const readerSource = sources.find((s) => s.id === readSourceId) ?? null;

  return (
    // .safe-frame keeps the app clear of the phone's status bar, notch and gesture bar (the Android
    // app draws edge-to-edge); in browsers the insets are 0.
    <div className="safe-frame flex h-dvh w-full overflow-hidden bg-paper text-ink">
      <Rail
        mode={mode}
        onMode={setMode}
        subjectName={subject?.name}
        onSettings={ENGINE === "local" ? () => setSettings("open") : undefined}
        settingsAttention={sync.state === "auth" || sync.state === "error"}
      />

      <main className="relative flex min-w-0 flex-1 flex-col">
        <div className={`min-h-0 flex-1 overflow-y-auto ${mode === "ask" ? "" : "pb-40"}`} id="mode-scroll">
          {mode === "library" && (
            <LibraryMode
              subjects={subjects}
              subject={subject}
              sources={sources}
              loadError={loadError}
              onSelectSubject={setSubjectId}
              onSubjectsChanged={async (selectId) => {
                await refreshSubjects();
                if (selectId !== undefined) setSubjectId(selectId);
              }}
              onSourcesChanged={async () => {
                await refreshSources();
                refreshSubjects();
              }}
              setSources={setSources}
              onOpen={openInReader}
              onCite={onCite}
            />
          )}
          {mode === "read" && (
            <ReadMode
              sources={sources}
              source={readerSource}
              onPickSource={setReadSourceId}
              focus={focus}
              threads={threads.filter((t) => t.kind === "margin" && t.sourceId === readSourceId)}
              activeThreadId={activeThreadId}
              onActivate={setActiveThreadId}
              onSelectText={openMarginThread}
              onAsk={ask}
              onDiscard={discardThread}
              onCite={onCite}
              onGoLibrary={() => setMode("library")}
            />
          )}
          {mode === "ask" && subjectId != null && (
            <AskMode
              threads={threads}
              activeId={askActiveId}
              setActiveId={setAskActiveId}
              onAsk={ask}
              onSetMode={(t, m) => patchThread(t.id, (x) => ({ ...x, mode: m }))}
              onDelete={discardThread}
              onRetry={(t) => {
                const r = forRetry(t);
                if (r) ask(r.trimmed, r.question);
              }}
              onCite={onCite}
              checkedCount={checkedIds.length}
              totalCount={sources.length}
              onGoLibrary={() => setMode("library")}
              generalAvailable={ENGINE === "local"}
            />
          )}
          {mode === "summarise" && subjectId != null && (
            <SummariseMode key={subjectId} {...studyProps(subjectId)} />
          )}
          {mode === "practice" && subjectId != null && (
            <PracticeMode key={subjectId} {...studyProps(subjectId)} />
          )}
          {mode === "listen" && subjectId != null && <ListenMode key={subjectId} {...studyProps(subjectId)} />}
        </div>

        {sheetOpen && sheetThread && mode !== "read" && mode !== "ask" && (
          <ResponseSheet
            thread={sheetThread}
            onCite={onCite}
            onClose={() => setSheetOpen(false)}
            onClear={() => {
              discardThread(sheetThread.id);
              setSheetOpen(false);
            }}
            onRetry={() => {
              const r = forRetry(sheetThread);
              if (r) ask(r.trimmed, r.question);
            }}
          />
        )}

        {subject && mode !== "ask" && (
          <CommandBar
            disabled={subjectId == null}
            busy={(mode === "read" ? readerTarget?.busy : sheetThread?.busy) ?? false}
            checkedCount={checkedIds.length}
            totalCount={sources.length}
            focusLabel={
              mode === "read"
                ? readerTarget?.anchor
                  ? `“${readerTarget.anchor.text.slice(0, 48)}${readerTarget.anchor.text.length > 48 ? "…" : ""}”`
                  : readerSource
                    ? `Margin of ${readerSource.title}`
                    : null
                : null
            }
            onClearFocus={readerTarget?.anchor ? () => setActiveThreadId(null) : undefined}
            canReopen={!!sheetThread && !sheetOpen && mode !== "read"}
            onReopen={() => setSheetOpen(true)}
            onSubmit={submitCommand}
          />
        )}
      </main>
      <ConfirmHost />
      {settings && (
        <SettingsSheet
          firstRun={settings === "first"}
          onClose={() => setSettings(null)}
          onImported={async () => {
            const list = await refreshSubjects();
            if (subjectId == null && list[0]) setSubjectId(list[0].id);
            else refreshSources();
          }}
        />
      )}
    </div>
  );
}

/** What a conversation's saved copy depends on (to skip saving unchanged ones). */
function signature(t: Thread): string {
  return JSON.stringify([t.turns, t.mode ?? "sources", t.title ?? "", t.anchor ?? null, t.sourceId ?? null]);
}
