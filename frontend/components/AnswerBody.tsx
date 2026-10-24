"use client";

import { Fragment, type ReactNode } from "react";
import type { Citation } from "@/lib/api";

type Props = {
  body: string;
  citations: Citation[];
  onCite: (c: Citation) => void;
  streaming?: boolean;
};

/**
 * A deliberately small Markdown subset (headings, lists, bold/italic/code, paragraphs)
 * that understands ⟦n⟧ citation tokens. Streaming text arrives mid-structure, so this
 * renderer never throws on half-finished syntax.
 */
export default function AnswerBody({ body, citations, onCite, streaming }: Props) {
  const lines = body.split("\n");
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];

  const inline = (text: string, key: string) => renderInline(text, key, citations, onCite);
  const flushPara = () => {
    if (para.length) {
      blocks.push(
        <p key={`p${blocks.length}`} className="my-2 first:mt-0">
          {inline(para.join(" "), `p${blocks.length}`)}
        </p>,
      );
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      const Tag = list.ordered ? "ol" : "ul";
      const k = `l${blocks.length}`;
      blocks.push(
        <Tag key={k} className={`my-2 space-y-1 pl-5 ${list.ordered ? "list-decimal" : "list-disc"} marker:text-muted`}>
          {list.items.map((it, i) => (
            <li key={i}>{inline(it, `${k}-${i}`)}</li>
          ))}
        </Tag>,
      );
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if (heading) {
      flushPara();
      flushList();
      blocks.push(
        <p key={`h${blocks.length}`} className="mt-3 mb-1 font-semibold tracking-tight text-ink">
          {inline(heading[2], `h${blocks.length}`)}
        </p>,
      );
    } else if (bullet || numbered) {
      flushPara();
      const ordered = !!numbered;
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((bullet ?? numbered)![1]);
    } else if (list && /^\s{2,}\S/.test(raw)) {
      list.items[list.items.length - 1] += " " + line.trim();
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();

  return (
    <div className="answer text-[0.94rem] leading-relaxed">
      {blocks}
      {streaming && <span className="caret" aria-hidden />}
    </div>
  );
}

function renderInline(text: string, key: string, citations: Citation[], onCite: (c: Citation) => void): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(⟦\d+⟧)|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(<Fragment key={`${key}t${i++}`}>{text.slice(last, m.index)}</Fragment>);
    if (m[1]) {
      const n = Number(m[1].slice(1, -1));
      const c = citations[n - 1];
      out.push(
        c ? (
          <button
            key={`${key}c${i++}`}
            type="button"
            onClick={() => onCite(c)}
            title={`${c.source_title}${c.page ? ` · p. ${c.page}` : ""}\n“${c.cited_text.slice(0, 160)}”`}
            className="cite-marker"
          >
            {n}
          </button>
        ) : null,
      );
    } else if (m[2]) out.push(<strong key={`${key}b${i++}`}>{m[2]}</strong>);
    else if (m[3]) out.push(<em key={`${key}i${i++}`}>{m[3]}</em>);
    else if (m[4])
      out.push(
        <code key={`${key}k${i++}`} className="rounded bg-sunken px-1 font-mono text-[0.85em]">
          {m[4]}
        </code>,
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(<Fragment key={`${key}t${i++}`}>{text.slice(last)}</Fragment>);
  return out;
}
