"use client";

import { Fragment, type ReactNode } from "react";
import katex from "katex";
import type { Citation } from "@/lib/api";

type Props = {
  body: string;
  citations: Citation[];
  onCite: (c: Citation) => void;
  streaming?: boolean;
  /** "chat": Ask AI's reading layout (serif, larger); default: compact (sheets, margin threads). */
  variant?: "chat" | "compact";
};

type Cite = { citations: Citation[]; onCite: (c: Citation) => void };

/**
 * Markdown for AI answers that understands ⟦n⟧ citation tokens and LaTeX maths (KaTeX):
 * headings, paragraphs, nested lists, > callouts, --- rules, tables, fenced code, $…$ / \(…\)
 * inline maths and $$…$$ / \[…\] display maths. Streaming text arrives mid-structure, so nothing
 * here throws on half-finished syntax: an unclosed $ or $$ just shows as text until it closes.
 */
export default function AnswerBody({ body, citations, onCite, streaming, variant = "compact" }: Props) {
  const c: Cite = { citations, onCite };
  const chat = variant === "chat";
  return (
    <div className={`answer ${chat ? "answer-chat font-reading text-[1.02rem] leading-[1.75]" : "text-[0.94rem] leading-relaxed"}`}>
      {renderBlocks(joinDisplayMath(body.split("\n")), "b", c, chat)}
      {streaming && <span className="caret" aria-hidden />}
    </div>
  );
}

/** Display maths written over several lines ($$ … $$ or \[ … \]) becomes one line, so blocks stay simple. */
function joinDisplayMath(lines: string[]): string[] {
  const out: string[] = [];
  let open: string[] | null = null;
  let closer = "";
  for (const line of lines) {
    if (open) {
      open.push(line.trim());
      if (line.includes(closer)) {
        out.push(open.join(" "));
        open = null;
      }
      continue;
    }
    const dollars = (line.match(/\$\$/g) ?? []).length;
    const brackets = line.includes("\\[") && !line.includes("\\]");
    if (dollars % 2 === 1 || brackets) {
      open = [line.trimEnd()];
      closer = dollars % 2 === 1 ? "$$" : "\\]";
    } else out.push(line);
  }
  if (open) out.push(...open); // still streaming: show what's there
  return out;
}

type Item = { level: number; ordered: boolean; text: string };

function renderBlocks(lines: string[], key: string, c: Cite, chat: boolean): ReactNode[] {
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let items: Item[] = [];
  const k = () => `${key}-${blocks.length}`;
  const inline = (t: string, kk: string) => renderInline(t, kk, c);

  const flushPara = () => {
    if (!para.length) return;
    const kk = k();
    blocks.push(
      <p key={kk} className="my-3 first:mt-0">
        {inline(para.join(" "), kk)}
      </p>,
    );
    para = [];
  };
  const flushList = () => {
    if (!items.length) return;
    blocks.push(<Fragment key={k()}>{renderList(items, 0, k(), inline)}</Fragment>);
    items = [];
  };
  const flush = () => {
    flushPara();
    flushList();
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();
    const fence = /^\s*```(\w*)/.exec(line);
    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^(\s*)[-*•+]\s+(.*)$/.exec(line);
    const numbered = /^(\s*)\d+[.)]\s+(.*)$/.exec(line);

    if (!line.trim()) {
      flushPara();
      // A blank line inside a list doesn't end it if the list carries on.
      const next = lines.slice(i + 1).find((l) => l.trim());
      if (!next || !/^\s*([-*•+]|\d+[.)])\s+/.test(next)) flushList();
    } else if (fence) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      blocks.push(
        <pre key={k()} className="my-3 overflow-x-auto rounded border border-line bg-sunken p-3 font-mono text-[0.85em] leading-normal">
          <code>{code.join("\n")}</code>
        </pre>,
      );
    } else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush();
      blocks.push(<hr key={k()} className="my-5 border-line" />);
    } else if (heading) {
      flush();
      const level = heading[1].length;
      const size = !chat ? "text-[1em]" : level <= 2 ? "text-[1.2em]" : level === 3 ? "text-[1.08em]" : "text-[1em]";
      const kk = k();
      blocks.push(
        <p key={kk} role="heading" aria-level={Math.min(level + 1, 6)} className={`mb-2 mt-5 font-sans font-semibold leading-snug tracking-tight text-ink first:mt-0 ${size}`}>
          {inline(heading[2].replace(/#+\s*$/, ""), kk)}
        </p>,
      );
    } else if (/^\s*>/.test(line)) {
      flush();
      const quoted: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quoted.push(lines[i].replace(/^\s*>\s?/, ""));
      i--;
      blocks.push(
        <div key={k()} className="my-4 rounded border-l-2 border-accent bg-accent-soft/40 px-4 py-2 [&>p]:my-1.5">
          {renderBlocks(quoted, k(), c, chat)}
        </div>,
      );
    } else if (/^\s*\|/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      flush();
      const rows: string[][] = [];
      const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((x) => x.trim());
      rows.push(cells(line));
      for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(cells(lines[i]));
      i--;
      const kk = k();
      blocks.push(
        <div key={kk} className="my-4 overflow-x-auto">
          <table className="w-full border-collapse font-sans text-[0.9em]">
            <thead>
              <tr>
                {rows[0].map((h, j) => (
                  <th key={j} className="border-b border-line px-3 py-2 text-left font-semibold">
                    {inline(h, `${kk}h${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(1).map((r, ri) => (
                <tr key={ri} className="border-b border-line/60">
                  {r.map((cell, j) => (
                    <td key={j} className="px-3 py-2 align-top">
                      {inline(cell, `${kk}r${ri}c${j}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    } else if (bullet || numbered) {
      flushPara();
      const m = (bullet ?? numbered)!;
      items.push({ level: Math.min(3, Math.floor(m[1].replace(/\t/g, "  ").length / 2)), ordered: !!numbered, text: m[2] });
    } else if (items.length && /^\s{2,}\S/.test(raw)) {
      items[items.length - 1].text += " " + line.trim();
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flush();
  return blocks;
}

/** Items with indent levels → nested <ul>/<ol>. */
function renderList(items: Item[], level: number, key: string, inline: (t: string, k: string) => ReactNode[]): ReactNode {
  const groups: { item: Item; children: Item[] }[] = [];
  for (const it of items) {
    if (it.level > level && groups.length) groups[groups.length - 1].children.push(it);
    else groups.push({ item: { ...it, level }, children: [] });
  }
  const ordered = groups[0]?.item.ordered;
  const Tag = ordered ? "ol" : "ul";
  return (
    <Tag className={`my-3 space-y-1.5 pl-6 ${ordered ? "list-decimal" : "list-disc"} marker:text-muted [&_ol]:my-1.5 [&_ul]:my-1.5`}>
      {groups.map((g, i) => (
        <li key={i} className="pl-1">
          {inline(g.item.text, `${key}-${level}-${i}`)}
          {g.children.length > 0 && renderList(g.children, level + 1, `${key}-${level}-${i}`, inline)}
        </li>
      ))}
    </Tag>
  );
}

const mathCache = new Map<string, string>();
function tex(src: string, display: boolean): string {
  const id = (display ? "D" : "I") + src;
  let html = mathCache.get(id);
  if (html == null) {
    html = katex.renderToString(src, { displayMode: display, throwOnError: false, strict: "ignore", output: "htmlAndMathml" });
    if (mathCache.size > 500) mathCache.clear();
    mathCache.set(id, html);
  }
  return html;
}

// Order matters: citations, display maths, inline maths, then emphasis and code.
const INLINE =
  /(⟦\d+⟧)|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\\$\w])\$(?!\s)((?:\\.|[^$\\\n])+?)(?<!\s)\$(?!\d)|\*\*(.+?)\*\*|(?<![*\w])\*(?!\s)([^*]+?)\*(?!\w)|`([^`]+)`/g;

function renderInline(text: string, key: string, c: Cite): ReactNode[] {
  const out: ReactNode[] = [];
  const re = new RegExp(INLINE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(<Fragment key={`${key}t${i++}`}>{text.slice(last, m.index)}</Fragment>);
    const kk = `${key}x${i++}`;
    if (m[1]) {
      const b = citeButton(m[1], kk, c);
      if (b) out.push(b);
    } else if (m[2] != null || m[3] != null) {
      // Citations right after a centred formula sit beside it rather than dropping to their own line.
      const trail = /(?:\s*⟦\d+⟧)+/y;
      trail.lastIndex = re.lastIndex;
      const t = trail.exec(text);
      if (t) re.lastIndex += t[0].length;
      out.push(
        <span key={kk} className="math-display">
          <span className="math-body" dangerouslySetInnerHTML={{ __html: tex((m[2] ?? m[3]).trim(), true) }} />
          {t && <span className="math-cites">{(t[0].match(/⟦\d+⟧/g) ?? []).map((tok, j) => citeButton(tok, `${kk}c${j}`, c))}</span>}
        </span>,
      );
      last = re.lastIndex;
      continue;
    } else if (m[4] != null || m[5] != null)
      out.push(<span key={kk} dangerouslySetInnerHTML={{ __html: tex((m[4] ?? m[5]).trim(), false) }} />);
    else if (m[6] != null) out.push(<strong key={kk} className="font-semibold">{renderInline(m[6], kk, c)}</strong>);
    else if (m[7] != null) out.push(<em key={kk}>{renderInline(m[7], kk, c)}</em>);
    else if (m[8] != null)
      out.push(
        <code key={kk} className="rounded bg-sunken px-1 font-mono text-[0.85em]">
          {m[8]}
        </code>,
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(<Fragment key={`${key}t${i++}`}>{text.slice(last)}</Fragment>);
  return out;
}

function citeButton(token: string, key: string, c: Cite): ReactNode {
  const n = Number(token.slice(1, -1));
  const cite = c.citations[n - 1];
  if (!cite) return null;
  return (
    <button
      key={key}
      type="button"
      onClick={() => c.onCite(cite)}
      title={`${cite.source_title}${cite.page ? ` · ${cite.page_label ?? "p."} ${cite.page}` : ""}\n“${cite.cited_text.slice(0, 160)}”`}
      className="cite-marker"
    >
      {n}
    </button>
  );
}
