import { localApi, streamChat as localStreamChat } from "./local/store";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
/** "local" (default): everything on this device + Gemini with the student's key (phone app/PWA).
 *  "server": the FastAPI backend on the laptop (set NEXT_PUBLIC_ENGINE=server). */
export const ENGINE: "local" | "server" = process.env.NEXT_PUBLIC_ENGINE === "server" ? "server" : "local";

export type Subject = {
  id: number;
  name: string;
  created_at: string;
  source_count: number;
  ib_course?: string | null;
  ib_level?: "SL" | "HL" | null;
};

export type Source = {
  id: number;
  subject_id: number;
  kind: "pdf" | "text" | "url" | "audio" | "video" | "slides" | "doc" | "sheet" | "image";
  title: string;
  url: string | null;
  checked: boolean;
  status: string;
  chunk_count: number;
  char_count: number;
  page_count: number;
  created_at: string;
  progress?: number | null;
  stage?: string | null;
  error?: string | null;
  can_retry?: boolean;
};

export type PageSpan = { page: number; start: number; end: number };

/** Short name of each kind of source, for cards and chips. */
export const KIND_LABEL: Record<Source["kind"], string> = {
  pdf: "PDF", text: "Notes", url: "Web", audio: "Lecture", video: "Video",
  slides: "Slides", doc: "Document", sheet: "Spreadsheet", image: "Photo",
};

/** What a source's "pages" are: PDF pages, slides, spreadsheet sheets, or sections (EPUB chapters). */
export function pageLabel(kind: Source["kind"] | undefined): { one: string; many: string; short: string } {
  if (kind === "slides") return { one: "slide", many: "slides", short: "slide" };
  if (kind === "sheet") return { one: "sheet", many: "sheets", short: "sheet" };
  if (kind === "doc") return { one: "section", many: "sections", short: "§" };
  return { one: "page", many: "pages", short: "p." };
}
export type SourceDetail = Source & { text: string; pages: PageSpan[] };

export type Citation = {
  source_id: number;
  source_title: string;
  chunk_id: number;
  start: number;
  end: number;
  page: number | null;
  cited_text: string;
  page_label?: string; // "p." | "slide" | "sheet" | "§" (older citations: p.)
};

export type StreamEvent =
  | { type: "sources"; sources: { source_id: number; chunk_id: number; title: string; page: number | null }[] }
  | { type: "text"; text: string }
  | { type: "cite"; citations: Citation[] }
  | { type: "error"; message: string }
  | { type: "done" };

// ---------- generated study material ----------

export type ArtifactKind = "deck" | "quiz" | "sheet" | "episode" | "summary" | "exam";
export type Grade = "again" | "hard" | "good" | "easy";

export type GenerateRequest = {
  kind: ArtifactKind;
  subtype?: string;
  source_ids: number[];
  focus?: string | null;
  count?: number;
  difficulty?: "easy" | "medium" | "hard";
  length?: "short" | "medium" | "long";
  page_from?: number | null;
  page_to?: number | null;
  extended?: boolean;
  types?: ("mcq" | "short" | "long")[];
};

export type ArtifactSummary = {
  id: number;
  subject_id: number;
  kind: ArtifactKind;
  subtype: string;
  title: string;
  params: {
    focus?: string | null;
    count?: number;
    difficulty?: string;
    length?: string;
    source_ids?: number[];
    page_from?: number | null;
    page_to?: number | null;
  };
  created_at: string;
  has_audio: boolean;
  card_count?: number;
  due_count?: number;
  question_count?: number;
  attempts?: number;
  best?: number | null;
  last?: number | null;
  minutes?: number;
  summary?: string;
  status?: "ready" | "processing" | "failed";
  error?: string | null;
  progress?: number | null;
  stage?: string | null;
  parts?: number | null;
  total_marks?: number;
  types?: string[];
  answered?: number;
  scored?: number;
  scored_of?: number;
};

export type MarkschemePoint = { text: string; marks: number };
export type Markband = { marks: string; descriptor: string };
export type ExamQuestion = {
  command_term: string;
  objective: number;
  question: string;
  marks: number;
  cite: number[];
  markscheme: {
    type: "points" | "markbands";
    points: MarkschemePoint[];
    markbands: Markband[];
    indicative: string[];
    notes: string;
  };
};
export type MarkResult = {
  marks_awarded: number;
  max_marks: number;
  points: { index: number; awarded: number; comment: string }[];
  band: string;
  strengths: string;
  improvements: string;
  model_answer: string;
};
export type IBOptions = {
  courses: string[];
  command_terms: { term: string; objective: number; definition: string }[];
  summary_formats: Record<string, string>;
};

export type CardItem = {
  id: number;
  front: string;
  back: string;
  cite: number[];
  reps: number;
  lapses: number;
  interval_days: number;
  due_at: string;
  is_new: boolean;
  next: Record<Grade, string>;
};

export type QuizQuestion = {
  type?: "mcq" | "short" | "long"; // missing on old quizzes = mcq
  question: string;
  options?: string[]; // mcq
  answer?: number; // mcq
  accept?: string[]; // short
  points?: { text: string; marks: number }[]; // long
  marks?: number;
  explanation: string;
  cite: number[];
};
export type QuizResult = {
  score: number;
  total: number;
  answers: (number | string | null)[];
  correct: (number | string | null)[];
  results: { type: string; marks: number; max: number; correct: boolean; feedback: string; points: number[] }[];
};
export type MapNode = { id: string; parent: string; label: string; note: string; cite: number[] };
export type EpisodeLine = { speaker: string; text: string; cite: number[] };

export type ArtifactDetail = ArtifactSummary & {
  passages: Citation[];
  cards?: CardItem[];
  content: {
    questions?: QuizQuestion[]; // for kind "exam" these are ExamQuestion[] (see examQuestions())
    body?: string;
    nodes?: MapNode[];
    lines?: EpisodeLine[];
    speakers?: string[];
    summary?: string;
    total?: number;
    parts?: number;
  };
  marked?: Record<string, { answer: string; result: MarkResult | null }>;
};

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {}
    throw new Error(detail || `Request failed (${res.status})`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

/** Multipart upload via XHR so big files (300 MB textbooks) can show upload progress; fetch can't. */
function uploadWithProgress<T>(path: string, file: Blob, filename: string, onUpload?: (f: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", file, filename);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_URL}${path}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onUpload?.(e.loaded / e.total);
    xhr.onload = () => {
      let body: { detail?: unknown } | null = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as T);
      else
        reject(
          new Error(
            typeof body?.detail === "string" ? body.detail : xhr.status === 0 ? "Upload failed" : `Upload failed (${xhr.status})`,
          ),
        );
    };
    xhr.onerror = () => reject(new Error("Upload failed: couldn't reach the API."));
    xhr.send(form);
  });
}

const send = (path: string, method: string, body?: unknown) =>
  fetch(`${API_URL}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

const serverApi = {
  subjects: () => fetch(`${API_URL}/subjects`).then((r) => json<Subject[]>(r)),
  createSubject: (name: string) => send("/subjects", "POST", { name }).then((r) => json<Subject>(r)),
  patchSubject: (id: number, patch: { name?: string; ib_course?: string; ib_level?: "SL" | "HL" | "" }) =>
    send(`/subjects/${id}`, "PATCH", patch).then((r) => json<Subject>(r)),
  ibOptions: () => fetch(`${API_URL}/ib/options`).then((r) => json<IBOptions>(r)),
  markQuestion: (examId: number, qi: number, answer: string) =>
    send(`/artifacts/${examId}/questions/${qi}/mark`, "POST", { answer }).then((r) => json<MarkResult>(r)),
  customQuestion: (subjectId: number, body: { question: string; marks: number; answer: string; source_ids: number[] }) =>
    send(`/subjects/${subjectId}/exam/custom`, "POST", body).then((r) => json<ArtifactDetail>(r)),
  deleteSubject: (id: number) => send(`/subjects/${id}`, "DELETE").then((r) => json<void>(r)),
  sources: (subjectId: number) => fetch(`${API_URL}/subjects/${subjectId}/sources`).then((r) => json<Source[]>(r)),
  source: (id: number) => fetch(`${API_URL}/sources/${id}`).then((r) => json<SourceDetail>(r)),
  addText: (subjectId: number, title: string, text: string) =>
    send(`/subjects/${subjectId}/sources/text`, "POST", { title: title || null, text }).then((r) => json<Source>(r)),
  addUrl: (subjectId: number, url: string) =>
    send(`/subjects/${subjectId}/sources/url`, "POST", { url }).then((r) => json<Source>(r)),
  /** PDFs up to 600 MB; parsed and indexed in the background after upload. */
  addPdf: (subjectId: number, file: File, onUpload?: (fraction: number) => void) =>
    uploadWithProgress<Source>(`/subjects/${subjectId}/sources/pdf`, file, file.name, onUpload),
  /** The laptop server reads PDFs only; other formats are read by the on-device (phone/web) version. */
  addFile: (subjectId: number, file: File, onUpload?: (fraction: number) => void) =>
    /\.pdf$/i.test(file.name) || file.type === "application/pdf"
      ? uploadWithProgress<Source>(`/subjects/${subjectId}/sources/pdf`, file, file.name, onUpload)
      : Promise.reject(new Error(`The laptop version only reads PDFs. Add ${file.name} in the phone or web app.`)),
  /** Any audio/video format up to 2 h; transcribed locally by Whisper in the background. */
  addRecording: (subjectId: number, file: Blob, filename: string, onUpload?: (fraction: number) => void) =>
    uploadWithProgress<Source>(`/subjects/${subjectId}/sources/recording`, file, filename, onUpload),
  addAudio: (subjectId: number, file: Blob, filename: string) => {
    const form = new FormData();
    form.append("file", file, filename);
    return fetch(`${API_URL}/subjects/${subjectId}/sources/audio`, { method: "POST", body: form }).then((r) =>
      json<Source>(r),
    );
  },
  artifacts: (subjectId: number, kind?: ArtifactKind) =>
    fetch(`${API_URL}/subjects/${subjectId}/artifacts${kind ? `?kind=${kind}` : ""}`).then((r) =>
      json<ArtifactSummary[]>(r),
    ),
  artifact: (id: number) => fetch(`${API_URL}/artifacts/${id}`).then((r) => json<ArtifactDetail>(r)),
  generate: (subjectId: number, req: GenerateRequest) =>
    send(`/subjects/${subjectId}/artifacts`, "POST", req).then((r) => json<ArtifactDetail>(r)),
  /** Re-run a failed generation in place, with its original settings. */
  retryArtifact: (id: number) => send(`/artifacts/${id}/retry`, "POST").then((r) => json<ArtifactDetail>(r)),
  deleteArtifact: (id: number) => send(`/artifacts/${id}`, "DELETE").then((r) => json<void>(r)),
  reviewQueue: (deckId: number) =>
    fetch(`${API_URL}/artifacts/${deckId}/review`).then((r) => json<{ cards: CardItem[]; next_due_at: string | null }>(r)),
  gradeCard: (cardId: number, grade: Grade) =>
    send(`/cards/${cardId}/review`, "POST", { grade }).then((r) => json<CardItem>(r)),
  resetDeck: (deckId: number) => send(`/artifacts/${deckId}/reset`, "POST").then((r) => json<void>(r)),
  submitAttempt: (quizId: number, answers: (number | string | null)[]) =>
    send(`/artifacts/${quizId}/attempts`, "POST", { answers }).then((r) => json<QuizResult>(r)),
  renderAudio: (episodeId: number) =>
    send(`/artifacts/${episodeId}/audio`, "POST").then((r) => json<ArtifactSummary>(r)),
  audioSrc: async (episodeId: number) => `${API_URL}/artifacts/${episodeId}/audio`,
  patchSource: (id: number, patch: Partial<Pick<Source, "checked" | "title">>) =>
    send(`/sources/${id}`, "PATCH", patch).then((r) => json<Source>(r)),
  /** Read a handwritten answer from photo(s), word for word (optionally just the answer to `question`). */
  photoAnswer: (files: Blob[], question?: string) => {
    const form = new FormData();
    files.forEach((f, i) => form.append("files", f, (f as File).name ?? `photo-${i}.jpg`));
    if (question) form.append("question", question);
    return fetch(`${API_URL}/vision/answer`, { method: "POST", body: form }).then((r) =>
      json<{ text: string; found: boolean }>(r),
    );
  },
  photoQuestion: (files: Blob[]) => {
    const form = new FormData();
    files.forEach((f, i) => form.append("files", f, (f as File).name ?? `photo-${i}.jpg`));
    return fetch(`${API_URL}/vision/question`, { method: "POST", body: form }).then((r) =>
      json<{ text: string; marks: number | null }>(r),
    );
  },
  quizPhoto: (quizId: number, files: Blob[]) => {
    const form = new FormData();
    files.forEach((f, i) => form.append("files", f, (f as File).name ?? `photo-${i}.jpg`));
    return fetch(`${API_URL}/artifacts/${quizId}/quiz-photo`, { method: "POST", body: form }).then((r) =>
      json<{ answers: (number | string | null)[] }>(r),
    );
  },
  retrySource: (id: number) => send(`/sources/${id}/retry`, "POST").then((r) => json<Source>(r)),
  deleteSource: (id: number) => send(`/sources/${id}`, "DELETE").then((r) => json<void>(r)),
};

export const api: typeof serverApi = ENGINE === "local" ? localApi : serverApi;

export type ChatPayload = {
  message: string;
  source_ids: number[];
  selection?: { source_id: number; text: string; start: number; end: number } | null;
  history?: { role: "user" | "assistant"; content: string }[];
};

/** Ask a question and invoke `onEvent` for each event (sources, text, cite, error, done) as it arrives. */
export function streamChat(
  subjectId: number,
  payload: ChatPayload,
  onEvent: (e: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return (ENGINE === "local" ? localStreamChat : serverStreamChat)(subjectId, payload, onEvent, signal);
}

async function serverStreamChat(
  subjectId: number,
  payload: ChatPayload,
  onEvent: (e: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_URL}/subjects/${subjectId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok || !res.body) {
    await json(res);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (line.startsWith("data: ")) onEvent(JSON.parse(line.slice(6)) as StreamEvent);
      }
    }
  }
}

/** An exam artifact's questions, typed as IB exam questions. */
export const examQuestions = (a: ArtifactDetail) => (a.content.questions ?? []) as unknown as ExamQuestion[];
