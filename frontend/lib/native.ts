/**
 * Phone features through Capacitor plugins, each with a web fallback so the same build runs as a
 * PWA in a browser: camera (photos of handwritten answers), haptics, a daily "cards due"
 * reminder (local notifications) and saving/sharing a file (backups).
 */
import { Capacitor } from "@capacitor/core";

export const isNative = () => Capacitor.isNativePlatform();

/** Take or pick one photo with the native camera sheet. null = cancelled or not on a phone. */
export async function nativePhoto(): Promise<File | null> {
  if (!isNative()) return null;
  const { Camera, CameraResultType, CameraSource } = await import("@capacitor/camera");
  try {
    const photo = await Camera.getPhoto({
      resultType: CameraResultType.Uri,
      source: CameraSource.Prompt,
      quality: 85,
      width: 1800,
      height: 1800,
      correctOrientation: true,
      promptLabelHeader: "Photo of your work",
      promptLabelPhoto: "Choose from gallery",
      promptLabelPicture: "Take a photo",
    });
    if (!photo.webPath) return null;
    const blob = await (await fetch(photo.webPath)).blob();
    return new File([blob], `photo-${Date.now()}.${photo.format || "jpg"}`, { type: blob.type || "image/jpeg" });
  } catch {
    return null; // the student closed the sheet
  }
}

/** A light tap for answers and grades (no-op in browsers without vibration). */
export async function tap(kind: "light" | "success" | "error" = "light") {
  try {
    if (isNative()) {
      const { Haptics, ImpactStyle, NotificationType } = await import("@capacitor/haptics");
      if (kind === "light") await Haptics.impact({ style: ImpactStyle.Light });
      else await Haptics.notification({ type: kind === "success" ? NotificationType.Success : NotificationType.Error });
    } else navigator.vibrate?.(kind === "light" ? 8 : kind === "success" ? [10, 40, 10] : 40);
  } catch {}
}

const REMINDER_ID = 4101;

/**
 * Schedule (or cancel) tomorrow-onwards daily reminders at `hour` when recall cards are due.
 * Called whenever the app opens, so the text reflects the current count.
 */
export async function scheduleReminder(on: boolean, hour: number, dueCount: number) {
  if (!isNative()) return;
  const { LocalNotifications } = await import("@capacitor/local-notifications");
  try {
    await LocalNotifications.cancel({ notifications: [{ id: REMINDER_ID }] });
    if (!on) return;
    const perm = await LocalNotifications.checkPermissions();
    if (perm.display !== "granted" && (await LocalNotifications.requestPermissions()).display !== "granted") return;
    await LocalNotifications.schedule({
      notifications: [
        {
          id: REMINDER_ID,
          title: "Marginalia",
          body:
            dueCount > 0
              ? `${dueCount} recall card${dueCount === 1 ? " is" : "s are"} due. A few minutes keeps them fresh.`
              : "Time for a quick review: your recall cards are waiting.",
          schedule: { on: { hour, minute: 0 }, allowWhileIdle: true },
        },
      ],
    });
  } catch {}
}

async function blobToBase64(b: Blob): Promise<string> {
  const buf = new Uint8Array(await b.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Save a file: the share sheet on Android (Drive, Files, email…), a download in a browser. */
export async function saveFile(blob: Blob, name: string) {
  if (isNative()) {
    const { Filesystem, Directory } = await import("@capacitor/filesystem");
    const { Share } = await import("@capacitor/share");
    const res = await Filesystem.writeFile({ path: name, data: await blobToBase64(blob), directory: Directory.Cache });
    await Share.share({ title: name, files: [res.uri] });
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
