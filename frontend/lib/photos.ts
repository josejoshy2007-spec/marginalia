/** Browser-side photo helpers shared by PhotoButton (marking) and Ask AI (photo questions). */
import { useEffect, useRef, type RefObject } from "react";


/** Downscale a phone photo to ≤1800 px JPEG before use (falls back to the original, e.g. HEIC). */
export async function shrink(file: File): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 1.5 * 1024 * 1024) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.85));
    return blob ? new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" }) : file;
  } catch {
    return file;
  }
}

/** A ≤320 px JPEG data URL, small enough to keep inside a saved conversation. "" if it can't be decoded. */
export async function makeThumb(file: Blob, max = 320): Promise<string> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.7);
  } catch {
    return "";
  }
}

/** Minimal shape of a paste event, so tests can fake it. */
export interface PasteLike {
  clipboardData?: {
    items?: ArrayLike<{ kind?: string; type: string; getAsFile(): File | null }> | null;
    getData?(format: string): string;
  } | null;
}

/**
 * Image files on the clipboard of a paste event (a screenshot, "copy image"). Reads only the event's
 * own `clipboardData`, so no permission prompt and it works in the Android WebView. Text-only pastes
 * give []. Callers should `preventDefault()` only when this returns something.
 */
export function imagesFromPaste(e: PasteLike): File[] {
  const items = e.clipboardData?.items;
  if (!items) return [];
  // Excel, Word and OneNote put text and a picture on the clipboard together; the text must paste normally.
  // Real screenshots carry no text, so they still come through.
  const text = e.clipboardData?.getData?.("text/plain") ?? "";
  if (text && text.trim()) return [];
  const out: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it.type.startsWith("image/")) continue;
    const f = it.getAsFile();
    if (!f) continue;
    // Screenshots arrive as "image.png"; give each a distinct, readable name.
    const ext = (it.type.split("/")[1] || "png").replace("jpeg", "jpg").replace(/\+.*$/, "");
    const generic = !f.name || /^image\.\w+$/i.test(f.name);
    out.push(generic ? new File([f], `pasted-screenshot-${out.length + 1}.${ext}`, { type: f.type, lastModified: f.lastModified }) : f);
  }
  return out;
}

/**
 * Calls `onImages` when images are pasted inside `scope` (a native listener, so it also catches pastes
 * from child textareas). Text pastes are untouched; the event is cancelled only when it held an image.
 */
export function usePasteImages(
  scope: RefObject<HTMLElement | null>,
  onImages: (files: File[]) => void,
  enabled = true,
) {
  const cb = useRef(onImages);
  cb.current = onImages;
  useEffect(() => {
    const el = scope.current;
    if (!el || !enabled) return;
    const handler = (e: Event) => {
      if (e.defaultPrevented) return;
      const files = imagesFromPaste(e as ClipboardEvent);
      if (!files.length) return;
      e.preventDefault();
      cb.current(files);
    };
    el.addEventListener("paste", handler);
    return () => el.removeEventListener("paste", handler);
  }, [scope, enabled]);
}
