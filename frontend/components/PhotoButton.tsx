"use client";

import { useRef, useState } from "react";
import { RetryLink } from "./study/shared";
import { CameraIcon } from "./icons";
import { isNative, nativePhoto } from "@/lib/native";

/** Downscale a phone photo to ≤1800 px JPEG before upload (falls back to the original, e.g. HEIC). */
async function shrink(file: File): Promise<File> {
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

/**
 * "Take/choose a photo" button. On phones it offers the camera or the gallery; several photos can
 * be picked at once (an answer that runs over two pages). `onPhotos` does the reading.
 */
export default function PhotoButton({
  label,
  busyLabel = "Reading your handwriting…",
  onPhotos,
  disabled,
}: {
  label: string;
  busyLabel?: string;
  onPhotos: (files: File[]) => Promise<void>;
  disabled?: boolean;
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

  return (
    <span className="inline-flex flex-col">
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
