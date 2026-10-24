import { db } from "./db";

/** User-editable settings, stored on the device. Defaults mirror the old backend/.env. */
export type Settings = {
  geminiKey: string;
  model: string;
  fallbackModel: string;
  ttsModel: string;
  embedModel: string;
  rpm: number; // text-model requests per minute we pace ourselves to (free tier)
  maxQuotaWait: number; // seconds we'll wait for a slot / short 429 cooldown
  maxTokens: number;
  retrievalK: number;
  remindersOn: boolean;
  reminderHour: number; // local hour for the daily "cards due" reminder
  syncOn: boolean; // Google Drive sync connected
  syncEmail: string;
  lastSyncAt: string;
};

export const DEFAULTS: Settings = {
  geminiKey: "",
  model: "gemini-3.8-flash",
  fallbackModel: "gemini-3.5-flash",
  ttsModel: "gemini-3.8-flash-tts",
  embedModel: "gemini-embedding-2",
  rpm: 8,
  maxQuotaWait: 20,
  maxTokens: 32768,
  retrievalK: 12,
  remindersOn: true,
  reminderHour: 17,
  syncOn: false,
  syncEmail: "",
  lastSyncAt: "",
};

export const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
export const EMBED_DIM = 768;

let cache: Settings | null = null;

export async function getSettings(): Promise<Settings> {
  if (cache) return cache;
  const rows = await db.settings.toArray();
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  cache = { ...DEFAULTS, ...(stored as Partial<Settings>) };
  return cache;
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  await db.settings.bulkPut(Object.entries(patch).map(([key, value]) => ({ key, value })));
  cache = null;
  return getSettings();
}
