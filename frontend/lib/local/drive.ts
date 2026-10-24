/**
 * Minimal Google Drive v3 client for the app's hidden appDataFolder. Files are gzip-compressed
 * JSON; uploads use the resumable protocol (no 5 MB limit). A 401 drops the cached token and
 * throws AuthNeeded so the caller can ask the student to sign in again.
 */
import { AuthNeeded, dropToken } from "./google";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";

export type DriveFile = { id: string; name: string; modifiedTime: string; size?: string };

export class DriveError extends Error {}

export interface Drive {
  list(): Promise<DriveFile[]>;
  read(id: string): Promise<unknown>;
  write(name: string, data: unknown, id?: string): Promise<DriveFile>;
  remove(id: string): Promise<void>;
  email(): Promise<string | null>;
}

async function gzip(data: unknown): Promise<Blob> {
  const stream = new Blob([JSON.stringify(data)]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).blob();
}

async function gunzip(res: Response): Promise<unknown> {
  const stream = res.body!.pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}

export function googleDrive(token: string): Drive {
  const call = async (url: string, init: RequestInit = {}): Promise<Response> => {
    let res: Response;
    try {
      res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
    } catch {
      throw new DriveError("Couldn't reach Google Drive. Check your internet connection.");
    }
    if (res.status === 401) {
      dropToken();
      throw new AuthNeeded();
    }
    if (!res.ok) {
      let msg = `${res.status}`;
      try {
        msg = (await res.json()).error?.message ?? msg;
      } catch {}
      if (res.status === 403 && /storage|quota/i.test(msg)) throw new DriveError("Your Google Drive is full.");
      throw new DriveError(`Google Drive error: ${msg}`);
    }
    return res;
  };

  return {
    async list() {
      const out: DriveFile[] = [];
      let page = "";
      do {
        const q = new URLSearchParams({ spaces: "appDataFolder", fields: "nextPageToken,files(id,name,modifiedTime,size)", pageSize: "1000" });
        if (page) q.set("pageToken", page);
        const data = await (await call(`${API}/files?${q}`)).json();
        out.push(...data.files);
        page = data.nextPageToken ?? "";
      } while (page);
      return out;
    },
    async read(id) {
      return gunzip(await call(`${API}/files/${id}?alt=media`));
    },
    async write(name, data, id) {
      const body = await gzip(data);
      // Resumable upload: start a session (create, or update an existing file), then send the bytes.
      const start = await call(
        id ? `${UPLOAD}/files/${id}?uploadType=resumable` : `${UPLOAD}/files?uploadType=resumable`,
        {
          method: id ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": "application/gzip" },
          body: JSON.stringify(id ? {} : { name, parents: ["appDataFolder"], mimeType: "application/gzip" }),
        },
      );
      const session = start.headers.get("Location");
      if (!session) throw new DriveError("Google Drive didn't accept the upload. Try again.");
      const res = await call(`${session}&fields=id,name,modifiedTime,size`, { method: "PUT", body });
      return res.json();
    },
    async remove(id) {
      try {
        await call(`${API}/files/${id}`, { method: "DELETE" });
      } catch (e) {
        if (!(e instanceof DriveError && e.message.includes("404"))) throw e;
      }
    },
    async email() {
      try {
        return (await (await call(`${API}/about?fields=user(emailAddress)`)).json()).user?.emailAddress ?? null;
      } catch (e) {
        if (e instanceof AuthNeeded) throw e;
        return null;
      }
    },
  };
}
