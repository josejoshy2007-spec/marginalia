/**
 * Labels for kinds of source. Kept free of imports so both the UI and the on-device engine can use
 * it without an import cycle (lib/api.ts imports the engine).
 */
export type SourceKind = "pdf" | "text" | "url" | "audio" | "video" | "slides" | "doc" | "sheet" | "image";

/** Short name of each kind of source, for cards and chips. */
export const KIND_LABEL: Record<SourceKind, string> = {
  pdf: "PDF", text: "Notes", url: "Web", audio: "Lecture", video: "Video",
  slides: "Slides", doc: "Document", sheet: "Spreadsheet", image: "Photo",
};

/** What a source's "pages" are: PDF pages, slides, spreadsheet sheets, or sections (EPUB chapters). */
export function pageLabel(kind: SourceKind | undefined): { one: string; many: string; short: string } {
  if (kind === "slides") return { one: "slide", many: "slides", short: "slide" };
  if (kind === "sheet") return { one: "sheet", many: "sheets", short: "sheet" };
  if (kind === "doc") return { one: "section", many: "sections", short: "§" };
  return { one: "page", many: "pages", short: "p." };
}
