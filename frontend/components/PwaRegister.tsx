"use client";

import { useEffect } from "react";
import { Capacitor } from "@capacitor/core";

/** Registers the offline service worker in the static (PWA) build. The Android app bundles its files already. */
export default function PwaRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || Capacitor.isNativePlatform() || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register(`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/sw.js`).catch(() => {});
  }, []);
  return null;
}
