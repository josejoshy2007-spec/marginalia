"use client";

import { useRef, useState, type RefObject } from "react";
import { RetryLink } from "./study/shared";
import { CameraIcon } from "./icons";
import { isNative, nativePhoto } from "@/lib/native";
import { shrink, usePasteImages } from "@/lib/photos";

/**
 * "Take/choose a photo" button. On phones it offers the camera or the gallery; several photos can
 * be picked at once (an answer that runs over two pages). `onPhotos` does the reading.
 */
export default function PhotoButton({
  label,
  busyLabel = "Reading your handwriting…",
  onPhotos,
  disabled,
  pasteScope,
}: {
  label: string;
  busyLabel?: string;
  onPhotos: (files: File[]) => Promise<void>;
  disabled?: boolean;
  /** Pasting an image inside this element (e.g. the answer box) is read like a picked photo. */
  pasteScope?: RefObject<HTMLElement | null>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const last = useRef<File[] | null>(null);
  const read = async (files: File[]) => {
    last.current = files;
    setBusy(true);
    setError(null);
    try {
      await onPhotos(files);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Pasting while this control is focused always works; `pasteScope` widens it to an answer area.
  const self = useRef<HTMLSpanElement>(null);
  const onPaste = (files: File[]) => {
    if (disabled || busy) return;
    void Promise.all(files.slice(0, 6).map(shrink)).then(read);
  };
  usePasteImages(self, onPaste);
  usePasteImages(pasteScope ?? self, onPaste, !!pasteScope);

  return (
    <span ref={self} className="inline-flex flex-col">
      <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={disabled || busy}
        onClick={async () => {
          if (!isNative()) return input.current?.click();
          // In the Android app: the system camera / gallery sheet (one photo per tap).
          const photo = await nativePhoto();
          if (photo) await read([await shrink(photo)]);
        }}
        className="btn-ghost"
        title="Upload or take photos of your written work"
      >
        <CameraIcon width={16} height={16} />
        {busy ? busyLabel : label}
      </button>
      {!busy && <span className="text-xs text-muted">or paste a screenshot</span>}
      </span>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={async (e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (!files.length) return;
          await read(await Promise.all(files.slice(0, 6).map(shrink)));
        }}
      />
      {error && (
        <span className="mt-1 flex max-w-xs flex-wrap items-center gap-2 text-xs text-danger">
          {error}
          {last.current && !busy && <RetryLink onRetry={() => read(last.current!)} />}
        </span>
      )}
    </span>
  );
}
