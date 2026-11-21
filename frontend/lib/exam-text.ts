/** Split text into prose and fenced code blocks (``` or ```lang ... ```); an unclosed fence runs to the end. */
export function splitFences(text: string): { code: boolean; lang: string; text: string }[] {
  const out: { code: boolean; lang: string; text: string }[] = [];
  const re = /```([\w+-]*)[ \t]*\n?([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text ?? "")) !== null) {
    if (m[0] === "") break;
    if (m.index > last) out.push({ code: false, lang: "", text: text.slice(last, m.index) });
    out.push({ code: true, lang: m[1] ?? "", text: (m[2] ?? "").replace(/\n+$/, "") });
    last = m.index + m[0].length;
  }
  if (last < (text ?? "").length) out.push({ code: false, lang: "", text: text.slice(last) });
  return out;
}
