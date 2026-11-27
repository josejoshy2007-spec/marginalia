/**
 * Free YouTube transcripts from the video's own captions (no AI call).
 * In the APK the watch page is fetched with CapacitorHttp (no CORS); in a plain browser CORS
 * usually blocks it, which counts as "no captions" and the caller falls back to Gemini.
 */

export interface CaptionTrack {
  baseUrl: string;
  languageCode?: string;
  kind?: string;
}

export interface Json3Event {
  tStartMs?: number;
  segs?: { utf8?: string }[];
}

const GROUP_SECONDS = 45;

const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** Extract a balanced JSON array that starts at `from` (the '['), honouring strings. */
function balancedArray(src: string, from: number): string | null {
  let depth = 0;
  let inStr = false;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return src.slice(from, i + 1);
  }
  return null;
}

/** The `captionTracks` array from a watch page's player response, or [] when there is none. */
export function captionTracks(html: string): CaptionTrack[] {
  const at = html.indexOf('"captionTracks":');
  if (at < 0) return [];
  const start = html.indexOf("[", at);
  if (start < 0) return [];
  const raw = balancedArray(html, start);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as CaptionTrack[];
    return arr.filter((t) => t && typeof t.baseUrl === "string" && t.baseUrl);
  } catch {
    return [];
  }
}

/** Manual English, then auto-generated English, then anything. */
export function pickTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  const en = (t: CaptionTrack) => (t.languageCode ?? "").toLowerCase().startsWith("en");
  return (
    tracks.find((t) => en(t) && t.kind !== "asr") ??
    tracks.find((t) => en(t)) ??
    tracks.find((t) => t.kind !== "asr") ??
    tracks[0] ??
    null
  );
}

export function videoTitle(html: string): string {
  const m = html.match(/<meta name="title" content="([^"]*)"/) ?? html.match(/<title>([^<]*)<\/title>/);
  if (!m) return "";
  return decodeEntities(m[1]).replace(/\s*-\s*YouTube\s*$/, "").trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Group timed lines into paragraphs of about 45 s, each opening with "(mm:ss)". */
export function groupLines(lines: { t: number; text: string }[]): string {
  const paras: string[] = [];
  let start = -1;
  let cur: string[] = [];
  const flush = () => {
    if (cur.length) paras.push(`(${mmss(start)}) ${cur.join(" ")}`);
    cur = [];
  };
  for (const l of lines) {
    const text = l.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (start < 0 || l.t - start >= GROUP_SECONDS) {
      flush();
      start = l.t;
    }
    cur.push(text);
  }
  flush();
  return paras.join("\n\n");
}

export function json3ToText(json: { events?: Json3Event[] }): string {
  const lines = (json.events ?? [])
    .filter((e) => e.segs)
    .map((e) => ({ t: (e.tStartMs ?? 0) / 1000, text: (e.segs ?? []).map((s) => s.utf8 ?? "").join("") }));
  return groupLines(lines);
}

export function xmlToText(xml: string): string {
  const lines: { t: number; text: string }[] = [];
  const re = /<text\b[^>]*?\bstart="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) lines.push({ t: Number(m[1]), text: decodeEntities(decodeEntities(m[2]).replace(/<[^>]+>/g, "")) });
  return groupLines(lines);
}

async function getText(url: string): Promise<string> {
  let native = false;
  try {
    const { Capacitor } = await import("@capacitor/core");
    native = Capacitor.isNativePlatform();
  } catch {
    /* plain browser / Node */
  }
  if (native) {
    const { CapacitorHttp } = await import("@capacitor/core");
    const res = await CapacitorHttp.get({
      url,
      responseType: "text",
      headers: { "Accept-Language": "en-US,en;q=0.9" },
      connectTimeout: 15000,
      readTimeout: 15000,
    });
    if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
    return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** `lengthSeconds` from the player response JSON in a watch page, or null. */
export function lengthSecondsOf(html: string): number | null {
  const m = html.match(/"lengthSeconds":\s*"?(\d+)"?/);
  return m ? Number(m[1]) : null;
}

export interface YoutubeInfo {
  title: string;
  minutes: number | null;
  hasCaptions: boolean;
}

/** Title, length and caption availability from the watch page; null on any failure. */
export async function youtubeInfo(videoId: string): Promise<YoutubeInfo | null> {
  try {
    const html = await getText(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`);
    const secs = lengthSecondsOf(html);
    // Tracks can be listed yet come back empty (PO-token tracks): only count captions that were really fetched.
    const fetched = captionTracks(html).length > 0 ? await fetchCaptionsFromHtml(html) : null;
    return {
      title: videoTitle(html) || "YouTube video",
      minutes: secs && secs > 0 ? Math.max(1, Math.round(secs / 60)) : null,
      hasCaptions: !!fetched?.text.trim(),
    };
  } catch {
    return null;
  }
}

/** Approximate tokens Gemini uses to watch a video at low media resolution (~100 per second). */
export const TOKENS_PER_VIDEO_SECOND = 100;
/** Rough size of a free day's token quota (not published per project; an assumption for the estimate). */
export const FREE_DAY_TOKENS = 1_000_000;
/** Videos up to this long go ahead without asking when there are no captions. */
export const CONFIRM_MINUTES = 15;

/** Whether to ask before sending a video to Gemini (no captions and long or unknown length). */
export function needsVideoConfirm(info: { minutes: number | null; hasCaptions: boolean } | null): boolean {
  if (info?.hasCaptions) return false;
  return info?.minutes == null || info.minutes > CONFIRM_MINUTES;
}

/** The confirmation text for a caption-less video. Estimates are approximate. */
export function videoCostMessage(minutes: number | null): string {
  if (minutes == null) return "No captions found — Gemini will watch this video (length unknown; a long video can use a whole day's free quota). Continue?";
  const tokens = minutes * 60 * TOKENS_PER_VIDEO_SECOND;
  const pct = Math.min(100, Math.round((tokens / FREE_DAY_TOKENS) * 100));
  const k = tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1000)}k`;
  return `No captions found — Gemini will watch this video (about ${minutes} min ≈ ${k} tokens, roughly ${pct}% of a free day's quota; approximate). Continue?`;
}

/** The video's captions as `(mm:ss)` paragraphs, or null when unavailable for any reason. */
export async function fetchCaptions(videoId: string): Promise<{ title: string; text: string } | null> {
  try {
    const html = await getText(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`);
    return await fetchCaptionsFromHtml(html);
  } catch {
    return null;
  }
}

async function fetchCaptionsFromHtml(html: string): Promise<{ title: string; text: string } | null> {
  try {
    const track = pickTrack(captionTracks(html));
    if (!track) return null;
    const base = track.baseUrl.replace(/\\u0026/g, "&");
    let text = "";
    try {
      const body = await getText(base + (base.includes("fmt=") ? "" : "&fmt=json3"));
      text = body.trimStart().startsWith("{") ? json3ToText(JSON.parse(body)) : xmlToText(body);
    } catch {
      text = xmlToText(await getText(base.replace(/&fmt=[^&]*/, "")));
    }
    if (!text.trim()) return null;
    return { title: videoTitle(html) || "YouTube video", text };
  } catch {
    return null;
  }
}

/** The 11-character video id from a watch / shorts / live / youtu.be URL. */
export function videoIdOf(url: string): string | null {
  const m = url.match(/(?:[?&]v=|youtu\.be\/|shorts\/|live\/)([\w-]{6,})/);
  return m ? m[1] : null;
}
