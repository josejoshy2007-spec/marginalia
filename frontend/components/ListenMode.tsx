"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type ArtifactDetail, type ArtifactSummary, type EpisodeLine } from "@/lib/api";
import {
  CiteMarks,
  ErrorNote,
  ModeHeader,
  NoSources,
  Segmented,
  scopeLabel,
  useArtifacts,
  Working,
  type StudyProps,
  isReady,
  JobStatus,
} from "./study/shared";
import { TrashIcon, WaveIcon } from "./icons";
import { askConfirm } from "@/lib/confirm";

type Format = "conversation" | "brief" | "debate" | "lecture";
type Length = "short" | "medium" | "long";

const FORMATS: { value: Format; label: string; blurb: string }[] = [
  { value: "conversation", label: "Talk-through", blurb: "Maya explains, Theo asks what you'd ask" },
  { value: "brief", label: "Quick brief", blurb: "One voice, only what matters most" },
  { value: "debate", label: "Debate", blurb: "Claims tested against counterpoints" },
  { value: "lecture", label: "Mini-lecture", blurb: "Step by step, with a worked example" },
];

export default function ListenMode(p: StudyProps) {
  const { items, busy, notice, error, setError, generate, remove, refresh, retry, retryLast } = useArtifacts(p.subjectId, "episode");
  const [format, setFormat] = useState<Format>("conversation");
  const [length, setLength] = useState<Length>("medium");
  const [focus, setFocus] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);

  if (openId != null)
    return <Episode {...p} id={openId} onExit={() => { setOpenId(null); refresh(); }} />;

  return (
    <div className="mx-auto max-w-5xl px-6 pt-10 sm:px-10">
      <ModeHeader eyebrow="Listen" title="Study with your ears" />
      {p.totalSources === 0 ? (
        <NoSources onGoLibrary={p.onGoLibrary} />
      ) : (
        <>
          <form
            className="mt-8 rounded-2xl border border-line bg-card p-5"
            onSubmit={async (e) => {
              e.preventDefault();
              const made = await generate(
                { source_ids: p.checkedIds, subtype: format, length, focus: focus || null },
                "Episode:",
                { openWhenReady: setOpenId },
              );
              if (made) setFocus("");
            }}
          >
            <p className="font-display text-xl">New episode</p>
            <p className="mt-1 text-sm text-muted">
              A spoken walkthrough of {scopeLabel(p.checkedIds.length, p.totalSources)}. Every line links back to
              the passage it came from.
            </p>
            <div className="mt-4 grid gap-2 sm:grid-cols-4">
              {FORMATS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => setFormat(f.value)}
                  className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${
                    format === f.value ? "border-ink bg-sunken" : "border-line hover:border-muted"
                  }`}
                >
                  <span className="block font-medium">{f.label}</span>
                  <span className="block text-xs text-muted">{f.blurb}</span>
                </button>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <input
                value={focus}
                onChange={(e) => setFocus(e.target.value)}
                placeholder="Steer it… (optional, e.g. focus on exam-style comparisons)"
                className="field min-w-[220px] flex-1"
              />
              <Segmented
                label="Length"
                value={length}
                onChange={setLength}
                options={[
                  { value: "short", label: "~3 min" },
                  { value: "medium", label: "~7 min" },
                  { value: "long", label: "~11 min" },
                ]}
              />
              <button className="btn-primary" disabled={!!busy || !p.checkedIds.length}>
                Make episode
              </button>
            </div>
            <Working label={busy} notice={notice} />
            {error && <ErrorNote text={error} onClose={() => setError(null)} onRetry={retryLast} />}
          </form>

          <section className="mt-8">
            {items === null ? (
              <p className="text-muted">Loading…</p>
            ) : items.length === 0 ? (
              <p className="text-muted">No episodes yet.</p>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2">
                {items.map((ep) => (
                  <EpisodeCard key={ep.id} ep={ep} onRetry={retry} onOpen={() => setOpenId(ep.id)} onDelete={() => askConfirm(`Delete “${ep.title}”?`).then((ok) => { if (ok) void remove(ep.id); })} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function EpisodeCard({
  ep,
  onOpen,
  onDelete,
  onRetry,
}: {
  ep: ArtifactSummary;
  onOpen: () => void;
  onDelete: () => void;
  onRetry: (id: number) => void;
}) {
  const fmt = FORMATS.find((f) => f.value === ep.subtype)?.label ?? ep.subtype;
  if (!isReady(ep))
    return (
      <li className="group flex gap-3 rounded-2xl border border-dashed border-line bg-card p-4">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-sunken text-muted">
          <WaveIcon />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-display text-lg leading-snug">{ep.title}</p>
          <JobStatus a={ep} onRetry={onRetry} />
        </div>
        <button type="button" title="Delete episode" onClick={onDelete} className="self-start text-muted opacity-0 hover:text-danger group-hover:opacity-100">
          <TrashIcon width={16} height={16} />
        </button>
      </li>
    );
  return (
    <li className="group flex gap-3 rounded-2xl border border-line bg-card p-4">
      <button type="button" onClick={onOpen} className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-ink text-paper" title="Play">
        <WaveIcon />
      </button>
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <p className="font-display text-lg leading-snug group-hover:text-accent">{ep.title}</p>
        <p className="mt-0.5 text-xs text-muted">
          {fmt} · ~{ep.minutes} min{ep.has_audio ? " · studio audio" : ""}
        </p>
        {ep.summary && <p className="mt-1 line-clamp-2 text-sm text-ink-soft">{ep.summary}</p>}
      </button>
      <button type="button" title="Delete episode" onClick={onDelete} className="self-start text-muted opacity-0 hover:text-danger group-hover:opacity-100">
        <TrashIcon width={16} height={16} />
      </button>
    </li>
  );
}

// ---------------------------------------------------------------- player

type Engine = "device" | "studio";

function Episode(p: StudyProps & { id: number; onExit: () => void }) {
  const [ep, setEp] = useState<ArtifactDetail | null>(null);
  const [engine, setEngine] = useState<Engine>("device");
  const [rendering, setRendering] = useState(false);
  const [renderErr, setRenderErr] = useState<string | null>(null);
  const renderAudio = async () => {
    if (!ep) return;
    setRendering(true);
    setRenderErr(null);
    try {
      await api.renderAudio(ep.id);
      setEp(await api.artifact(ep.id));
    } catch (e) {
      setRenderErr((e as Error).message);
    } finally {
      setRendering(false);
    }
  };
  const [active, setActive] = useState(-1);
  const seekRef = useRef<(i: number) => void>(() => {});

  useEffect(() => {
    api.artifact(p.id).then((e) => {
      setEp(e);
      if (e.has_audio) setEngine("studio");
    });
  }, [p.id]);

  const lines = ep?.content.lines ?? [];
  const speakers = ep?.content.speakers ?? ["Maya"];

  useEffect(() => {
    if (active < 0) return;
    document.querySelector(`[data-line="${active}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [active]);

  return (
    <div className="mx-auto max-w-3xl px-6 pt-8">
      <button type="button" onClick={p.onExit} className="btn-ghost">
        ← Episodes
      </button>
      <h1 className="mt-4 font-display text-3xl leading-tight">{ep?.title ?? "…"}</h1>
      {ep?.content.summary && <p className="mt-2 text-ink-soft">{ep.content.summary}</p>}

      {ep && (
        <div className="sticky top-3 z-10 mt-6 rounded-2xl border border-line bg-card/95 p-4 shadow-sm backdrop-blur">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <Segmented<Engine>
              label="Voice"
              value={engine}
              onChange={(v) => {
                window.speechSynthesis?.cancel();
                setActive(-1);
                setEngine(v);
              }}
              options={[
                { value: "device", label: "Device voices" },
                { value: "studio", label: "Studio audio" },
              ]}
            />
            <span className="text-xs text-muted">
              {engine === "device"
                ? "Free and instant, using your browser's built-in speech."
                : "Natural voices from Gemini. Uses your speech quota."}
            </span>
          </div>
          {engine === "device" ? (
            <DevicePlayer lines={lines} speakers={speakers} active={active} setActive={setActive} seekRef={seekRef} />
          ) : ep.has_audio ? (
            <StudioPlayer ep={ep} lines={lines} setActive={setActive} seekRef={seekRef} />
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="btn-primary"
                disabled={rendering}
                onClick={renderAudio}
              >
                {rendering ? "Recording…" : "Make studio audio"}
              </button>
              <span className="text-sm text-muted">
                {rendering ? "This can take a minute or two." : "About one speech request per 2 minutes of audio."}
              </span>
              {renderErr && <ErrorNote text={renderErr} onRetry={renderAudio} />}
            </div>
          )}
        </div>
      )}

      <ol className="mt-6 space-y-1 pb-10">
        {lines.map((ln, i) => (
          <Line
            key={i}
            i={i}
            line={ln}
            active={i === active}
            speakerIndex={Math.max(0, speakers.indexOf(ln.speaker))}
            onClick={() => seekRef.current(i)}
            cites={ep ? <CiteMarks cite={ln.cite} passages={ep.passages} onCite={p.onCite} /> : null}
          />
        ))}
      </ol>
    </div>
  );
}

function Line({
  i,
  line,
  active,
  speakerIndex,
  onClick,
  cites,
}: {
  i: number;
  line: EpisodeLine;
  active: boolean;
  speakerIndex: number;
  onClick: () => void;
  cites: React.ReactNode;
}) {
  return (
    <li
      data-line={i}
      onClick={onClick}
      className={`grid cursor-pointer grid-cols-[4.5rem_1fr] gap-3 rounded-xl px-3 py-2 transition-colors ${
        active ? "bg-accent-soft" : "hover:bg-sunken"
      }`}
    >
      <span className={`pt-0.5 text-xs font-semibold uppercase tracking-wider ${speakerIndex ? "text-moss" : "text-accent"}`}>
        {line.speaker}
      </span>
      <p className="font-reading leading-relaxed">
        {line.text} {cites}
      </p>
    </li>
  );
}

/** Reads the script aloud line by line with the browser's speech synthesis, two distinct voices. */
function DevicePlayer({
  lines,
  speakers,
  active,
  setActive,
  seekRef,
}: {
  lines: EpisodeLine[];
  speakers: string[];
  active: number;
  setActive: (i: number) => void;
  seekRef: React.RefObject<(i: number) => void>;
}) {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState<"1" | "1.25" | "1.5">("1");
  const playingRef = useRef(false);
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;

  useEffect(() => {
    if (!supported) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => {
      window.speechSynthesis.removeEventListener("voiceschanged", load);
      window.speechSynthesis.cancel();
    };
  }, [supported]);

  const voiceFor = useMemo(() => {
    const en = voices.filter((v) => v.lang.toLowerCase().startsWith("en"));
    const pool = en.length ? en : voices;
    const femaleHint = /female|zira|samantha|jenny|aria|susan|karen|victoria|libby|sonia|natasha|emma/i;
    const a = pool.find((v) => femaleHint.test(v.name)) ?? pool[0];
    const b = pool.find((v) => v !== a && !femaleHint.test(v.name)) ?? pool.find((v) => v !== a) ?? a;
    return (speaker: string) => (speakers.indexOf(speaker) === 1 ? b : a);
  }, [voices, speakers]);

  const speakFrom = useCallback(
    (i: number) => {
      if (!supported) return;
      window.speechSynthesis.cancel();
      if (i >= lines.length) {
        playingRef.current = false;
        setPlaying(false);
        setActive(-1);
        return;
      }
      playingRef.current = true;
      setPlaying(true);
      setActive(i);
      const u = new SpeechSynthesisUtterance(lines[i].text);
      const v = voiceFor(lines[i].speaker);
      if (v) u.voice = v;
      u.rate = Number(rate);
      u.pitch = speakers.indexOf(lines[i].speaker) === 1 ? 0.95 : 1.05;
      u.onend = () => {
        if (playingRef.current) speakFrom(i + 1);
      };
      window.speechSynthesis.speak(u);
    },
    [supported, lines, voiceFor, rate, speakers, setActive],
  );

  useEffect(() => {
    seekRef.current = speakFrom;
  }, [seekRef, speakFrom]);

  const pause = () => {
    playingRef.current = false;
    setPlaying(false);
    window.speechSynthesis.cancel();
  };

  if (!supported) return <p className="text-sm text-danger">This browser has no built-in speech. Try Studio audio.</p>;

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={() => (playing ? pause() : speakFrom(Math.max(0, active)))}
        className="grid h-11 w-11 place-items-center rounded-full bg-accent text-lg text-white"
        title={playing ? "Pause" : "Play"}
      >
        {playing ? "❚❚" : "▶"}
      </button>
      <button type="button" className="btn-ghost" onClick={() => speakFrom(Math.max(0, active - 1))} title="Previous line">
        ↺ back
      </button>
      <span className="text-sm text-muted">
        {active >= 0 ? `Line ${active + 1} of ${lines.length}` : `${lines.length} lines`}
      </span>
      <span className="ml-auto">
        <Segmented
          label="Speed"
          value={rate}
          onChange={(r) => {
            setRate(r);
            if (playing) setTimeout(() => speakFrom(active), 0);
          }}
          options={[
            { value: "1", label: "1×" },
            { value: "1.25", label: "1.25×" },
            { value: "1.5", label: "1.5×" },
          ]}
        />
      </span>
    </div>
  );
}

/** Plays the rendered WAV; the active transcript line is estimated from word counts. */
function StudioPlayer({
  ep,
  lines,
  setActive,
  seekRef,
}: {
  ep: ArtifactDetail;
  lines: EpisodeLine[];
  setActive: (i: number) => void;
  seekRef: React.RefObject<(i: number) => void>;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    api.audioSrc(ep.id).then(setSrc, () => setSrc(undefined));
  }, [ep.id]);
  const cumulative = useMemo(() => {
    const words = lines.map((l) => l.text.split(/\s+/).length);
    const total = words.reduce((a, b) => a + b, 0) || 1;
    let acc = 0;
    return words.map((w) => {
      const start = acc / total;
      acc += w;
      return start;
    });
  }, [lines]);

  useEffect(() => {
    seekRef.current = (i: number) => {
      const a = audio.current;
      if (!a || !a.duration) return;
      a.currentTime = cumulative[i] * a.duration;
      a.play();
    };
  }, [seekRef, cumulative]);

  return (
    <audio
      ref={audio}
      controls
      preload="metadata"
      src={src}
      className="w-full"
      onTimeUpdate={(e) => {
        const a = e.currentTarget;
        if (!a.duration) return;
        const f = a.currentTime / a.duration;
        let i = 0;
        while (i + 1 < cumulative.length && cumulative[i + 1] <= f) i++;
        setActive(i);
      }}
      onEnded={() => setActive(-1)}
    />
  );
}
