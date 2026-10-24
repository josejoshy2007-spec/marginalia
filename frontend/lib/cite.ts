import type { Citation } from "./api";

/** Resolve `cite` passage numbers (1-based) against an artifact's frozen passages. */
export function resolveCites(cite: number[] | undefined, passages: Citation[]): Citation[] {
  return (cite ?? []).map((n) => passages[n - 1]).filter(Boolean);
}

/**
 * Turn inline [n] / [1, 3] markers in generated Markdown into the ⟦n⟧ tokens AnswerBody renders
 * as citation buttons. Numbers outside the passage list (e.g. "[1990]") are left alone.
 */
export function markersToTokens(body: string, passageCount: number): string {
  return body.replace(/\[(\d{1,3}(?:\s*[,;]\s*\d{1,3})*)\]/g, (whole, list: string) => {
    const nums = list.split(/\s*[,;]\s*/).map(Number).filter((n) => n >= 1 && n <= passageCount);
    return nums.length ? nums.map((n) => `⟦${n}⟧`).join("") : whole;
  });
}
