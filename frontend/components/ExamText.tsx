"use client";

import { splitFences } from "@/lib/exam-text";
import { MathText } from "./AnswerBody";

/**
 * Exam text with LaTeX maths (via MathText) and fenced code blocks shown monospaced. MathText alone
 * has no code blocks, and exam questions for programming papers carry code.
 */
export function ExamText({ text, className }: { text: string; className?: string }) {
  const parts = splitFences(text ?? "");
  if (!parts.some((p) => p.code)) return <MathText text={text ?? ""} className={className} />;
  return (
    <div className={className}>
      {parts.map((p, i) =>
        p.code ? (
          <pre key={i} className="my-2 overflow-x-auto whitespace-pre rounded border border-line bg-sunken px-3 py-2 font-mono text-[13px] leading-snug text-ink">
            <code>{p.text}</code>
          </pre>
        ) : p.text.trim() ? (
          <div key={i} className="whitespace-pre-wrap">
            <MathText text={p.text.replace(/^\n+|\n+$/g, "")} />
          </div>
        ) : null,
      )}
    </div>
  );
}
