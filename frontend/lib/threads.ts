import type { Citation } from "./api";

export type Anchor = { start: number; end: number; text: string };

export type Turn =
  | { role: "user"; text: string }
  // `body` holds the answer text with ⟦n⟧ tokens marking where citation n (1-based) applies.
  | { role: "assistant"; body: string; citations: Citation[]; error?: string };

export type Thread = {
  /** Also the saved conversation's global uid, so it's the same on every synced device. */
  id: string;
  /** "margin": beside a source in Read mode; "sheet": the bottom bar's quick answers; "ask": an Ask AI chat. */
  kind: "margin" | "sheet" | "ask";
  /** Answer from the checked sources (default) or from general knowledge (Ask AI's "Ask anything"). */
  mode?: "sources" | "general";
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  sourceId?: number;
  anchor?: Anchor | null;
  turns: Turn[];
  busy: boolean;
};

export const CITE_TOKEN = /⟦(\d+)⟧/g;

export const stripCites = (s: string) => s.replace(CITE_TOKEN, "");

/** The thread minus its last question/answer pair, plus that question, for re-asking after an error. */
export function forRetry(thread: Thread): { trimmed: Thread; question: string } | null {
  const idx = thread.turns.map((t) => t.role).lastIndexOf("user");
  if (idx < 0) return null;
  const q = thread.turns[idx];
  return q.role === "user" ? { trimmed: { ...thread, turns: thread.turns.slice(0, idx) }, question: q.text } : null;
}

export function newThreadId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/** A short title from the first question. */
export function threadTitle(t: Thread): string {
  const first = t.turns.find((x) => x.role === "user");
  const q = first?.role === "user" ? first.text.replace(/\s+/g, " ").trim() : "";
  return t.title || (q ? q.slice(0, 70) + (q.length > 70 ? "…" : "") : "New conversation");
}

/** Add citations to an answer, reusing numbers for identical passages, and return the tokens to append. */
export function addCitations(existing: Citation[], incoming: Citation[]): { citations: Citation[]; tokens: string } {
  const citations = [...existing];
  const nums: number[] = [];
  for (const c of incoming) {
    let i = citations.findIndex((x) => x.source_id === c.source_id && x.start === c.start && x.end === c.end);
    if (i === -1) {
      citations.push(c);
      i = citations.length - 1;
    }
    if (!nums.includes(i + 1)) nums.push(i + 1);
  }
  return { citations, tokens: nums.map((n) => `⟦${n}⟧`).join("") };
}
