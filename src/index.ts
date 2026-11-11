// The official Node.js and TypeScript client for the Reelspan API (https://api.reelspan.com/v1). No dependencies:
// it uses the platform's fetch, FormData and Web Crypto, so it also runs on Deno, Bun and edge runtimes.
//
// Robust by default: network errors, 429s and 5xx answers are retried with backoff (honouring Retry-After), and every
// post carries an Idempotency-Key, so a retried post is never published twice.

export const VERSION = '1.0.1';

export type Fields = Record<string, string | number | boolean | string[] | undefined | null>;
/** A file to upload: bytes with a name, a Blob or File, or a public https URL (Google Drive and Dropbox share links work). */
export type FileInput = string | Blob | { data: Uint8Array | ArrayBuffer; name: string; type?: string };

/** Every network Reelspan publishes to. `sandbox` accepts everything and publishes nothing, for tests. */
export type Platform =
  | 'tiktok'
  | 'youtube'
  | 'instagram'
  | 'facebook'
  | 'x'
  | 'threads'
  | 'linkedin'
  | 'pinterest'
  | 'bluesky'
  | 'reddit'
  | 'google_business'
  | 'telegram'
  | 'discord'
  | 'slack'
  | 'mastodon'
  | 'devto'
  | 'hashnode'
  | 'wordpress'
  | 'sandbox';

export type ReelspanOptions = {
  /** An API key from the dashboard (Developers → API keys). Defaults to the REELSPAN_API_KEY environment variable. */
  apiKey?: string;
  /** Defaults to https://api.reelspan.com (or REELSPAN_BASE_URL) */
  baseUrl?: string;
  /** Your own fetch (for proxies or tests). */
  fetch?: typeof fetch;
  /** Milliseconds before one attempt is abandoned (default 120 000; uploads can take a while). */
  timeoutMs?: number;
  /** How many times a failed request is tried again: network errors, 408, 409 (in progress), 429 and 5xx (default 2). */
  maxRetries?: number;
  /** Sent on every request, e.g. to tag your app in your own logs. */
  headers?: Record<string, string>;
  /** Files at or above this many bytes go straight to storage in parts (default 90 MB). */
  directUploadBytes?: number;
};

export type RequestOptions = {
  /** Makes a POST safe to retry: the same key never publishes twice. Posts get one automatically. */
  idempotencyKey?: string;
  /** Overrides the client's maxRetries for this call. */
  maxRetries?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
};

/** The rate limit the API reported on the last answer. */
export type RateLimit = { limit: number; remaining: number; reset: number };

/** An error answer from the API, with its HTTP status and machine-readable code. */
export class ReelspanError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly body: Record<string, unknown>;
  /** Seconds the API asked to wait (429 and 503), when it said. */
  readonly retryAfter: number | null;
  constructor(status: number, body: Record<string, unknown>, retryAfter: number | null = null) {
    super(typeof body.message === 'string' ? body.message : `Reelspan API error ${status}`);
    this.name = 'ReelspanError';
    this.status = status;
    this.code = typeof body.error_code === 'string' ? body.error_code : null;
    this.body = body;
    this.retryAfter = retryAfter;
  }
  get isRateLimited() {
    return this.status === 429;
  }
}

/** The request never got an answer: the network failed or it timed out (after the retries). */
export class ReelspanConnectionError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ReelspanConnectionError';
  }
}

// API answers are plain JSON whose fields callers read directly; the main ones are typed below, with the rest open
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;

/** One network's outcome for a post. */
export type PlatformResult = Json & { platform: string; success: boolean; url?: string | null; post_id?: string | null; error?: string | null; error_code?: string | null; skipped?: boolean };
/** The answer to a post: results per network when it was sent now, a job_id when scheduled, a request_id when async. */
export type PostResponse = Json & { success: boolean; request_id?: string; job_id?: string; results?: Record<string, PlatformResult>; usage?: Json };
/** Where a post stands: `pending`, `in_progress`, `completed`, `failed` or `cancelled`, with each network's result. */
export type PostStatus = Json & { status: string; results: PlatformResult[] };
export type Profile = Json & { username: string; display_name: string | null; created_at: string; social_accounts: Record<string, Json | ''> };
export type MediaUpload = Json & { success: true; media_id: string; kind: 'video' | 'photo' | 'document'; content_type: string; size_bytes: number; duration_seconds: number | null };

type Req = { query?: Fields; json?: unknown; form?: FormData } & RequestOptions;

// read without Node's types, so the package builds and runs where there is no `process` (browsers, edge)
const env = (k: string): string | undefined => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[k];
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });
const uuid = () => (typeof globalThis.crypto?.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
const enc = encodeURIComponent;

function appendFields(form: FormData, fields: Fields) {
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const x of v) form.append(k.endsWith('[]') ? k : `${k}[]`, x);
    else form.append(k, String(v));
  }
}

function toBlob(file: Exclude<FileInput, string>): Blob {
  if (file instanceof Blob) return file;
  const bytes = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
  return new Blob([bytes as BlobPart], { type: file.type ?? 'application/octet-stream' });
}
const nameOf = (file: Exclude<FileInput, string>, fallback: string) => (file instanceof Blob ? ((file as File).name ?? fallback) : file.name);

function appendFile(form: FormData, field: string, file: FileInput) {
  if (typeof file === 'string') return form.append(field, file);
  form.append(field, toBlob(file), nameOf(file, field));
}

export type PostCommon = {
  /** The profile's username */
  user: string;
  platforms: (Platform | (string & {}))[];
  /** The caption (and the YouTube title) */
  title?: string;
  description?: string;
  /** ISO-8601; returns 202 with a job_id */
  scheduledDate?: string;
  timezone?: string;
  /** Takes the profile's next free queue slot */
  addToQueue?: boolean;
  /** Return at once with a request_id instead of waiting for the results */
  async?: boolean;
  firstComment?: string;
  repeatEvery?: 'day' | 'week' | 'month';
  repeatTimes?: number;
  /** Your own id for the post, returned in webhooks and history */
  externalId?: string;
  /** Any other field the API accepts, e.g. { tiktok_privacy_level: 'PUBLIC_TO_EVERYONE', reddit_subreddit: 'videos' } */
  extra?: Fields;
} & Pick<RequestOptions, 'idempotencyKey' | 'signal'>;

function common(p: PostCommon): Fields {
  return {
    user: p.user,
    'platform[]': p.platforms,
    title: p.title,
    description: p.description,
    scheduled_date: p.scheduledDate,
    timezone: p.timezone,
    add_to_queue: p.addToQueue ? 'true' : undefined,
    async_upload: p.async ? 'true' : undefined,
    first_comment: p.firstComment,
    repeat_every: p.repeatEvery,
    repeat_times: p.repeatTimes,
    external_id: p.externalId,
    ...p.extra,
  };
}
const postOpts = (p: PostCommon): RequestOptions => ({ idempotencyKey: p.idempotencyKey ?? uuid(), signal: p.signal });

export type HistoryQuery = { page?: number; limit?: 10 | 20 | 50 | 100; platform?: string; status?: 'success' | 'failed'; profile_username?: string; request_id?: string; job_id?: string; external_id?: string; start?: string; end?: string };

/** Files at or above this size go straight to storage in parts (POST /v1/media/uploads) instead of one request. */
export const DIRECT_UPLOAD_BYTES = 90 * 1024 * 1024;

export class Reelspan {
  private readonly key: string;
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly headers: Record<string, string>;
  private readonly directUploadBytes: number;
  /** The rate limit reported on the last answer, if any. */
  rateLimit: RateLimit | null = null;

  constructor(opts: ReelspanOptions = {}) {
    const key = opts.apiKey ?? env('REELSPAN_API_KEY');
    if (!key) throw new Error('Reelspan: pass apiKey or set REELSPAN_API_KEY');
    this.key = key;
    this.base = (opts.baseUrl ?? env('REELSPAN_BASE_URL') ?? 'https://api.reelspan.com').replace(/\/+$/, '');
    this.doFetch = opts.fetch ?? ((...a) => fetch(...a));
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.maxRetries = Math.max(0, opts.maxRetries ?? 2);
    this.headers = opts.headers ?? {};
    this.directUploadBytes = opts.directUploadBytes ?? DIRECT_UPLOAD_BYTES;
  }

  /** Any endpoint: `request('GET', '/v1/me')`. Returns the parsed JSON; throws ReelspanError on an error status. */
  async request<T = Json>(method: string, path: string, req: Req = {}): Promise<T> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
    const headers: Record<string, string> = { ...this.headers, authorization: `Bearer ${this.key}`, accept: 'application/json', 'x-reelspan-sdk': `node/${VERSION}` };
    if (req.idempotencyKey) headers['idempotency-key'] = req.idempotencyKey;
    let body: BodyInit | undefined;
    if (req.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(req.json);
    }
    // a GET, PUT or DELETE repeats safely; a POST or PATCH only with an idempotency key
    const safe = ['GET', 'HEAD', 'PUT', 'DELETE'].includes(method.toUpperCase()) || !!req.idempotencyKey;
    const tries = (req.maxRetries ?? this.maxRetries) + 1;
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        const timeout = AbortSignal.timeout(req.timeoutMs ?? this.timeoutMs);
        const signal = req.signal ? anySignal(req.signal, timeout) : timeout;
        // a FormData body is rebuilt per attempt by the caller passing the same instance: fetch doesn't consume it
        res = await this.doFetch(url.toString(), { method, headers, body: req.form ?? body, signal });
      } catch (err) {
        if (req.signal?.aborted) throw err;
        if (safe && attempt < tries) {
          await sleep(backoff(attempt), req.signal);
          continue;
        }
        const timedOut = (err as Error)?.name === 'TimeoutError';
        throw new ReelspanConnectionError(timedOut ? `Reelspan: no answer within ${req.timeoutMs ?? this.timeoutMs} ms` : `Reelspan: could not reach ${this.base} (${(err as Error)?.message ?? err})`, err);
      }
      this.noteRateLimit(res);
      const text = await res.text();
      let parsed: Json = {};
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = { message: text.slice(0, 500) };
      }
      if (res.ok) return parsed as T;
      const retryAfter = Number(res.headers.get('retry-after')) || null;
      const retryable = res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500;
      if (retryable && (safe || res.status === 429) && attempt < tries) {
        await sleep(retryAfter ? Math.min(retryAfter, 60) * 1000 : backoff(attempt), req.signal);
        continue;
      }
      throw new ReelspanError(res.status, parsed, retryAfter);
    }
  }

  private noteRateLimit(res: Response) {
    const limit = Number(res.headers.get('x-ratelimit-limit'));
    if (limit) this.rateLimit = { limit, remaining: Number(res.headers.get('x-ratelimit-remaining')), reset: Number(res.headers.get('x-ratelimit-reset')) };
  }

  /** The key's account: plan, usage and limits. */
  me() {
    return this.request('GET', '/v1/me');
  }

  /** Every network and whether it is open, with what it takes. Needs no key scope. */
  platforms() {
    return this.request('GET', '/platforms');
  }

  readonly profiles = {
    list: () => this.request<Json & { profiles: Profile[]; limit: number; plan: string }>('GET', '/v1/profiles'),
    get: (username: string) => this.request<Json & { profile: Profile }>('GET', `/v1/profiles/${enc(username)}`),
    create: (username: string, displayName?: string) => this.request<Json & { profile: Profile }>('POST', '/v1/profiles', { json: { username, display_name: displayName } }),
    rename: (username: string, displayName: string | null) => this.request<Json & { profile: Profile }>('PATCH', `/v1/profiles/${enc(username)}`, { json: { display_name: displayName } }),
    delete: (username: string) => this.request('DELETE', '/v1/profiles', { json: { username } }),
    /** @deprecated use `connect.link` */
    connectLink: (username: string, branding: Json = {}) => this.connect.link(username, branding),
    /** @deprecated use `accounts.disconnect` */
    disconnect: (username: string, platform: string) => this.accounts.disconnect(username, platform),
  };

  /** The accounts connected to a profile. */
  readonly accounts = {
    /**
     * Connects a network that uses credentials instead of an OAuth sign-in (Telegram, Discord, Slack, Mastodon,
     * WordPress, Dev.to, Hashnode, Bluesky). The fields are checked with the network
     * first. Upload-Post's field names work too, e.g. `{ chat_id }`, `{ instance_url, access_token }`.
     */
    connect: (username: string, platform: Platform | (string & {}), credentials: Record<string, string | number | string[]>) =>
      this.request<Json & { success: true; platform: string; account: string; reconnected: boolean }>('POST', `/v1/accounts/${enc(platform)}`, { json: { profile_username: username, ...credentials } }),
    disconnect: (username: string, platform: string) => this.request('DELETE', '/v1/accounts', { json: { profile_username: username, social_platform: platform } }),
  };

  /** Connecting accounts for people who have no Reelspan login (your customers). */
  readonly connect = {
    /** A hosted, branded page where they connect networks to this profile. */
    link: (username: string, branding: Json = {}) => this.request<Json & { access_url: string; duration: string }>('POST', '/v1/connect-links', { json: { username, ...branding } }),
    /** Checks a connect token from a link (as your own page would). */
    validate: (token: string) => this.validateToken(token),
    /** Starts an OAuth connection and returns the network's authorize_url to send them to. */
    oauthStart: (platform: Platform | (string & {}), opts: { profile?: string; redirectUrl?: string } = {}) =>
      this.request<Json & { authorize_url: string; state: string; expires_in: number }>('POST', `/v1/oauth/${enc(platform)}/start`, { json: { profile: opts.profile, redirect_url: opts.redirectUrl } }),
  };

  // the token, not the API key, is the credential here
  private async validateToken(token: string) {
    const res = await this.doFetch(`${this.base}/v1/connect-links/validate`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
    const body = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) throw new ReelspanError(res.status, body);
    return body;
  }

  readonly posts = {
    /** A video file, bytes, or a public URL; or `videoMediaId` from media.upload / the library. Large files go up in parts first. */
    video: async (p: PostCommon & { video?: FileInput; videoMediaId?: string; thumbnail?: FileInput }) => {
      let mediaId = p.videoMediaId;
      if (!mediaId && p.video && typeof p.video !== 'string' && toBlob(p.video).size >= this.directUploadBytes) mediaId = (await this.media.upload(p.video, { kind: 'video' })).media_id;
      const form = new FormData();
      appendFields(form, { ...common(p), video_media_id: mediaId });
      if (p.video !== undefined && !mediaId) appendFile(form, 'video', p.video);
      if (p.thumbnail !== undefined) appendFile(form, typeof p.thumbnail === 'string' ? 'thumbnail_url' : 'thumbnail', p.thumbnail);
      return this.request<PostResponse>('POST', '/v1/posts/video', { form, ...postOpts(p) });
    },
    /** One photo or a carousel: files, bytes or public URLs, in order; or `photoMediaIds`. */
    photos: (p: PostCommon & { photos?: FileInput[]; photoMediaIds?: string[]; altTexts?: string[] }) => {
      const form = new FormData();
      appendFields(form, { ...common(p), 'photo_media_ids[]': p.photoMediaIds, 'alt_text[]': p.altTexts });
      for (const ph of p.photos ?? []) appendFile(form, 'photos[]', ph);
      return this.request<PostResponse>('POST', '/v1/posts/photos', { form, ...postOpts(p) });
    },
    /** Text only. Long text becomes a thread on X and Bluesky. */
    text: (p: PostCommon) =>
      this.request<PostResponse>('POST', '/v1/posts/text', {
        json: Object.fromEntries(
          Object.entries(common(p))
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k === 'platform[]' ? 'platform' : k, v]),
        ),
        ...postOpts(p),
      }),
    /** A PDF to LinkedIn, shown as a swipeable document. */
    document: (p: PostCommon & { document?: FileInput; documentMediaId?: string }) => {
      const form = new FormData();
      appendFields(form, { ...common(p), document_media_id: p.documentMediaId });
      if (p.document !== undefined) appendFile(form, 'document', p.document);
      return this.request<PostResponse>('POST', '/v1/posts/document', { form, ...postOpts(p) });
    },
    /** Each network's result for a request_id (or a scheduled job_id). */
    status: (id: { requestId?: string; jobId?: string }) => this.request<PostStatus>('GET', '/v1/posts/status', { query: { request_id: id.requestId, job_id: id.jobId } }),
    /** Polls status until every network has finished (or the timeout passes). */
    /** Polls status (every 5 s by default, the API's advice) until every network has finished, or the timeout passes. */
    wait: async (requestId: string, opts: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {}) => {
      const end = Date.now() + (opts.timeoutMs ?? 600_000);
      for (;;) {
        const s = await this.request<PostStatus>('GET', '/v1/posts/status', { query: { request_id: requestId }, signal: opts.signal });
        if (['completed', 'failed', 'cancelled'].includes(s.status) || Date.now() > end) return s;
        await sleep(opts.intervalMs ?? 5000, opts.signal);
      }
    },
    /**
     * Sends the failed networks again, with the media it already has. `fields` changes settings for this try (e.g. a
     * new caption). Not repeated automatically on a network error: the server can't tell a repeat from a new retry.
     */
    retry: (requestId: string, opts: string[] | { platforms?: string[]; fields?: Fields; jobId?: string } = {}) => {
      const o = Array.isArray(opts) ? { platforms: opts } : opts;
      return this.request<PostResponse>('POST', '/v1/posts/retry', { json: { request_id: requestId, job_id: o.jobId, platforms: o.platforms, fields: o.fields } });
    },
    /** One page of history, one row per network post. */
    history: (query: HistoryQuery = {}) =>
      this.request<Json & { history: Json[]; in_progress: Json[]; total: number; page: number; limit: number }>('GET', '/v1/posts', { query }),
    /** Every history row, page by page: `for await (const row of reelspan.posts.all({ platform: 'tiktok' }))`. */
    all: (query: Omit<HistoryQuery, 'page' | 'limit'> = {}) => this.historyRows(query),
  };

  private async *historyRows(query: Omit<HistoryQuery, 'page' | 'limit'>) {
    for (let page = 1; ; page++) {
      const r = await this.posts.history({ ...query, limit: 100, page });
      yield* r.history;
      if (page * r.limit >= r.total || !r.history.length) return;
    }
  }

  readonly scheduled = {
    list: (query: Fields = {}) => this.request('GET', '/v1/scheduled', { query }),
    get: (jobId: string) => this.request('GET', `/v1/scheduled/${enc(jobId)}`),
    edit: (jobId: string, patch: { scheduled_date?: string; timezone?: string; title?: string; description?: string; fields?: Fields }) => this.request('PATCH', `/v1/scheduled/${enc(jobId)}`, { json: patch }),
    /** `withLaterRepeats` also cancels the later posts of a repeating series. */
    cancel: (jobId: string, opts: { withLaterRepeats?: boolean } = {}) => this.request('DELETE', `/v1/scheduled/${enc(jobId)}`, { query: { series: opts.withLaterRepeats ? 'rest' : undefined } }),
  };

  readonly queue = {
    settings: (username: string) => this.request('GET', '/v1/queue/settings', { query: { profile_username: username } }),
    setSettings: (username: string, settings: Json) => this.request('POST', '/v1/queue/settings', { json: { profile_username: username, ...settings } }),
    preview: (username: string, count?: number) => this.request('GET', '/v1/queue/preview', { query: { profile_username: username, count } }),
    nextSlot: (username: string) => this.request('GET', '/v1/queue/next-slot', { query: { profile_username: username } }),
    /** Keeps the queue from using this slot (ISO-8601 with an offset). */
    markFull: (username: string, slot: string) => this.request('POST', '/v1/queue/slot-full', { json: { profile_username: username, slot_datetime: slot } }),
    markOpen: (username: string, slot: string) => this.request('DELETE', '/v1/queue/slot-full', { json: { profile_username: username, slot_datetime: slot } }),
  };

  readonly media = {
    /**
     * Uploads a file once and returns its media_id, to post or keep in the library. Files from 90 MB go straight to
     * storage in parts (with retries per part), up to your plan's limit; smaller ones in one request.
     */
    upload: async (file: Exclude<FileInput, string>, opts: { kind?: 'video' | 'photo' | 'document'; save?: boolean; title?: string; onProgress?: (sent: number, total: number) => void } = {}): Promise<MediaUpload> => {
      const blob = toBlob(file);
      if (blob.size < this.directUploadBytes) {
        const form = new FormData();
        form.append('file', blob, nameOf(file, 'file'));
        const r = await this.request<MediaUpload>('POST', '/v1/media/upload', { form, query: { kind: opts.kind, save: opts.save ? 'true' : undefined, title: opts.title } });
        opts.onProgress?.(blob.size, blob.size);
        return r;
      }
      const r = await this.uploadInParts(blob, nameOf(file, 'file'), opts.kind ?? 'video', opts.onProgress);
      if (opts.save) await this.library.keep([r.media_id], opts.title);
      return r;
    },
  };

  private async uploadInParts(blob: Blob, filename: string, kind: 'video' | 'photo' | 'document', onProgress?: (sent: number, total: number) => void): Promise<MediaUpload> {
    const start = await this.request<Json & { media_id: string; part_size: number; parts: { part_number: number; url: string }[] }>('POST', '/v1/media/uploads', { json: { kind, size_bytes: blob.size, filename } });
    const done: { part_number: number; etag: string }[] = [];
    let sent = 0;
    try {
      // three parts at a time
      const queue = [...start.parts];
      const worker = async () => {
        for (let part = queue.shift(); part; part = queue.shift()) {
          const chunk = blob.slice((part.part_number - 1) * start.part_size, part.part_number * start.part_size);
          for (let attempt = 1; ; attempt++) {
            try {
              const res = await this.doFetch(part.url, { method: 'PUT', body: chunk, signal: AbortSignal.timeout(this.timeoutMs) });
              const etag = res.headers.get('etag');
              if (!res.ok || !etag) throw new Error(`storage answered ${res.status}`);
              done.push({ part_number: part.part_number, etag });
              sent += chunk.size;
              onProgress?.(sent, blob.size);
              break;
            } catch (err) {
              if (attempt > this.maxRetries + 1) throw new ReelspanConnectionError(`Reelspan: part ${part.part_number} of the upload failed (${(err as Error).message})`, err);
              await sleep(backoff(attempt));
            }
          }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      return await this.request<MediaUpload>('POST', `/v1/media/uploads/${enc(start.media_id)}/complete`, { json: { parts: done.sort((a, b) => a.part_number - b.part_number) } });
    } catch (err) {
      await this.request('POST', `/v1/media/uploads/${enc(start.media_id)}/abort`, { maxRetries: 0 }).catch(() => undefined);
      throw err;
    }
  }

  readonly library = {
    list: (query: { kind?: 'video' | 'photo' | 'document'; limit?: number; before?: string } = {}) => this.request('GET', '/v1/library', { query }),
    keep: (mediaIds: string[], title?: string) => this.request('POST', '/v1/library', { json: { media_ids: mediaIds, title } }),
    /** From a Google Drive or Dropbox share link, or any public https link. */
    import: (url: string, title?: string) => this.request('POST', '/v1/library/import', { json: { url, title } }),
    remove: (mediaId: string) => this.request('DELETE', `/v1/library/${enc(mediaId)}`),
    /** A short-lived link to download the file. */
    fileUrl: async (mediaId: string) => {
      const res = await this.doFetch(`${this.base}/v1/library/${enc(mediaId)}/file`, { headers: { authorization: `Bearer ${this.key}` }, redirect: 'manual' });
      const location = res.headers.get('location');
      if (location) return location;
      throw new ReelspanError(res.status, (await res.json().catch(() => ({}))) as Json);
    },
  };

  /** Captions written by AI (each call uses one AI credit). */
  readonly ai = {
    /** Captions for each network from whatever the post has: your text, an uploaded video (mediaId) or photos. */
    writeCaptions: (input: { text?: string; notes?: string; mediaId?: string; photoMediaIds?: string[]; platforms?: string[]; kind?: 'video' | 'photo' | 'text'; language?: string }) =>
      this.request('POST', '/v1/ai/adapt-captions', { json: { text: input.text, notes: input.notes, media_id: input.mediaId, photo_media_ids: input.photoMediaIds, platforms: input.platforms, kind: input.kind, language: input.language } }),
    /** Your captions, adapted to each network's style and limits: `{ youtube: { title: '…' } }`. */
    rewriteCaptions: (content: Json, opts: { platforms?: string[]; language?: string; instructions?: string } = {}) => this.request('POST', '/v1/ai/rewrite-captions', { json: { content, ...opts } }),
  };

  readonly pinterest = {
    /** Creates a board on the profile's Pinterest account. */
    createBoard: (username: string, name: string) => this.request<Json & { board: { id: string; name: string } }>('POST', '/v1/pinterest/boards', { json: { profile_username: username, name } }),
  };

  readonly analytics = {
    account: (username: string, platforms?: string[]) => this.request('GET', `/v1/analytics/${enc(username)}`, { query: { platforms } }),
    history: (username: string, query: { days?: number; platforms?: string[] } = {}) => this.request('GET', `/v1/analytics/${enc(username)}/history`, { query }),
    post: (requestId: string, platform?: string) => this.request('GET', `/v1/post-analytics/${enc(requestId)}`, { query: { platform } }),
    bestTimes: (username: string, query: { timezone?: string; platforms?: string[] } = {}) => this.request('GET', `/v1/best-times/${enc(username)}`, { query }),
    report: (username: string, days = 30) => this.request('GET', `/v1/reports/${enc(username)}`, { query: { days } }),
  };

  readonly approvals = {
    /** Scheduled posts by `jobIds`, or every post of a request by `requestIds`. */
    create: (p: { user: string; jobIds?: string[]; requestIds?: string[]; title?: string; note?: string; expiresInDays?: number }) =>
      this.request('POST', '/v1/approval-links', { json: { profile_username: p.user, job_ids: p.jobIds, request_ids: p.requestIds, title: p.title, note: p.note, expires_in_days: p.expiresInDays } }),
    list: (username?: string) => this.request('GET', '/v1/approval-links', { query: { profile_username: username } }),
    delete: (id: string) => this.request('DELETE', `/v1/approval-links/${enc(id)}`),
  };

  readonly webhooks = {
    get: () => this.request('GET', '/v1/webhook'),
    set: (url: string, events?: string[]) => this.request('POST', '/v1/webhook', { json: { webhook_url: url, webhook_events: events } }),
    delete: () => this.request('DELETE', '/v1/webhook'),
    test: () => this.request('POST', '/v1/webhook/test'),
    deliveries: (limit?: number) => this.request('GET', '/v1/webhook/deliveries', { query: { limit } }),
    redeliver: (deliveryId: string) => this.request('POST', `/v1/webhook/deliveries/${enc(deliveryId)}/redeliver`),
    /** A new signing secret; the old one stops working. */
    rotateSecret: () => this.request<Json & { webhook_secret: string }>('POST', '/v1/webhook/secret'),
    /** A profile's own webhook, sent in addition to the account one. */
    profile: {
      get: (username: string) => this.request('GET', '/v1/profile-webhook', { query: { profile_username: username } }),
      set: (username: string, url: string, events?: string[]) => this.request('POST', '/v1/profile-webhook', { json: { profile_username: username, webhook_url: url, webhook_events: events } }),
      delete: (username: string) => this.request('DELETE', '/v1/profile-webhook', { json: { profile_username: username } }),
    },
  };
}

/** Aborts when either does (AbortSignal.any where it exists; early Node 20 releases lack it). */
function anySignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  const c = new AbortController();
  for (const s of [a, b]) {
    if (s.aborted) c.abort(s.reason);
    else s.addEventListener('abort', () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}

/** Exponential backoff with jitter: about 0.5 s, 1 s, 2 s… up to 8 s. */
function backoff(attempt: number) {
  const base = Math.min(8000, 500 * 2 ** (attempt - 1));
  return base / 2 + Math.random() * (base / 2);
}

/**
 * Checks a webhook really came from Reelspan: pass the raw body (exactly as received), the x-reelspan-signature and
 * x-reelspan-timestamp headers, and your signing secret. Rejects anything older than `toleranceSeconds` (default 5 min).
 */
export async function verifyWebhook(rawBody: string, signature: string | null | undefined, timestamp: string | null | undefined, secret: string, toleranceSeconds = 300): Promise<boolean> {
  if (!signature || !timestamp || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSeconds) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${rawBody}`)));
  const expected = `sha256=${[...mac].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

export default Reelspan;
