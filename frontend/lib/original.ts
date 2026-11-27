/** Helpers for Read mode's "Original" view (pure; tested by scripts/original-test.mts). */

const TS = /^\s*\(\s*(?:(\d{1,2}):)?(\d{1,3}):(\d{2})\s*\)/;

/** Seconds for a `(mm:ss)` or `(h:mm:ss)` stamp at the very start of `text`, else null. */
export function leadingTimestamp(text: string): number | null {
  const m = TS.exec(text);
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  const min = Number(m[2]);
  const s = Number(m[3]);
  if (s > 59) return null;
  return h * 3600 + min * 60 + s;
}

/**
 * Where to seek for a citation starting at `start` in `text`: the stamp at the start of the cited text, otherwise
 * the stamp opening the paragraph that contains it (transcripts open each paragraph with one).
 */
export function timestampAt(text: string, start: number): number | null {
  const direct = leadingTimestamp(text.slice(start, start + 24));
  if (direct != null) return direct;
  const para = text.lastIndexOf("\n\n", start);
  return leadingTimestamp(text.slice(para < 0 ? 0 : para + 2, (para < 0 ? 0 : para + 2) + 24));
}

/** The 11-character YouTube video id of a watch/shorts/live/youtu.be link, or null. */
export function youtubeId(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|live\/)|youtu\.be\/)([\w-]{6,})/.exec(url);
  return m ? m[1] : null;
}

/** Privacy-friendly embed URL, optionally starting at `seconds`. */
export function youtubeEmbedUrl(id: string, seconds?: number | null): string {
  const t = seconds && seconds > 0 ? `?start=${Math.floor(seconds)}` : "";
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}${t}`;
}
