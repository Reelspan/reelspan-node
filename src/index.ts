// The official Node.js and TypeScript client for the Reelspan API (https://api.reelspan.com/v1). No dependencies:
// it uses the platform's fetch, FormData and Web Crypto, so it also runs on Deno, Bun and edge runtimes.
//
// Robust by default: network errors, 429s and 5xx answers are retried with backoff (honouring Retry-After), and every
// post carries an Idempotency-Key, so a retried post is never published twice.

export const VERSION = '1.1.0';

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

/**
 * A live post on a network: `requestId` for a post Reelspan published (with `platform` when it went to several
 * networks), or `platform`, `user` and `postId` (the network's own id) for any post of the profile's account.
 */
export type PostTarget = { requestId?: string; platform?: Platform | (string & {}); user?: string; postId?: string };
/** A post to read or answer comments on: `postId`, `postUrl` (Instagram, Bluesky) or the `requestId` that published it. */
export type CommentTarget = { platform: Platform | (string & {}); user: string; postId?: string; postUrl?: string; requestId?: string };
/** A published YouTube video: the `requestId` that published it, or `user` with the YouTube `videoId`. */
export type YouTubeVideo = { requestId?: string; user?: string; videoId?: string };
/** A link button on a private reply or DM (Instagram, Facebook). */
export type LinkButton = { title: string; url: string };

export type Comment = Json & { id: string; text: string; created_at: string | null; author: Json & { id: string | null; username: string | null }; parent_id: string | null };
export type CommentAction = 'hide' | 'unhide' | 'like' | 'unlike' | 'approve' | 'ignore' | 'hold' | 'ban_author' | 'edit' | 'enable_comments' | 'disable_comments';
export type AutoDmMonitor = Json & {
  monitor_id: string;
  platform: string;
  post_id: string;
  status: 'running' | 'paused' | 'stopped' | 'expired';
  stats: { total_comments: number; new_comments: number; successful_replies: number; failed_replies: number };
};
export type SubtitleTrack = Json & { id: string; language: string; name: string; kind?: string | null; status?: string | null; draft?: boolean };
export type ActivityType = 'posts' | 'comments' | 'accounts' | 'team' | 'developers' | 'billing' | 'security';
export type ActivityEntry = Json & {
  id: string;
  at: string;
  action: string;
  type: ActivityType | 'other';
  platform: string | null;
  profile: string | null;
  actor: { kind: 'member' | 'key' | 'system'; id: string | null; name: string };
  target: { type: string | null; id: string | null };
  metadata: Json;
};
export type Preferences = { weekStartDay: 0 | 1; timezone: string | null };
export type LimitWindow = { used: number; limit: number; remaining: number; window_seconds: number };

const postTarget = (t: PostTarget) => ({ request_id: t.requestId, platform: t.platform, user: t.user, post_id: t.postId });
const commentTarget = (t: CommentTarget) => ({ platform: t.platform, user: t.user, post_id: t.postId, post_url: t.postUrl, request_id: t.requestId });
const ytVideo = (v: YouTubeVideo) => ({ request_id: v.requestId, user: v.user, video_id: v.videoId });

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
    retry: (requestId: string, opts: string[] | { platforms?: string[]; fields?: Fields; jobId?: string; scheduledDate?: string; timezone?: string } = {}) => {
      const o = Array.isArray(opts) ? { platforms: opts } : opts;
      const later = Array.isArray(opts) ? {} : { scheduled_date: opts.scheduledDate, timezone: opts.timezone };
      return this.request<PostResponse>('POST', '/v1/posts/retry', { json: { request_id: requestId, job_id: o.jobId, platforms: o.platforms, fields: o.fields, ...later } });
    },
    /** Deletes a live post on the network itself (not TikTok, which has no delete, or Instagram stories). */
    unpublish: (target: PostTarget) =>
      this.request<Json & { success: true; platform: string; post_id: string; message: string }>('POST', '/v1/posts/unpublish', { json: postTarget(target) }),
    /**
     * Changes a live post where the network allows it. `fields` changes network settings by upload field name
     * (e.g. `{ pinterest_link: 'https://…' }`). An edit on X makes a new post id, returned with `previous_post_id`.
     */
    edit: (target: PostTarget & { text?: string; title?: string; description?: string; fields?: Record<string, string> }) =>
      this.request<Json & { success: true; platform: string; post_id: string; url: string | null; previous_post_id?: string; warnings?: string[] }>('POST', '/v1/posts/edit', {
        json: { ...postTarget(target), text: target.text, title: target.title, description: target.description, fields: target.fields },
      }),
    /** Reshares a post from the profile's account (any public post, not only your own). */
    repost: (target: PostTarget & { commentary?: string; targetLinkedinPageId?: string }) =>
      this.request<Json & { success: true; platform: string; post_id: string; repost_id: string | null; url: string | null }>('POST', '/v1/posts/repost', {
        json: { ...postTarget(target), commentary: target.commentary, target_linkedin_page_id: target.targetLinkedinPageId },
      }),
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
    /** Signed links (valid an hour) to every file the scheduled post will publish, to play or show it. */
    preview: (jobId: string) =>
      this.request<Json & { success: true; job_id: string; expires_in: number; media: { role: string; media_id: string; kind: string; content_type: string; size_bytes: number; url: string }[] }>('GET', `/v1/scheduled/${enc(jobId)}/preview`),
    /** A signed link (valid an hour) to a 480 px JPEG of the post: a video frame, or the cover or first photo. */
    thumbnail: (jobId: string) => this.request<Json & { success: true; thumbnail_url: string; expires_in: number }>('GET', `/v1/scheduled/${enc(jobId)}/thumbnail`, { query: { format: 'json' } }),
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
    /** The boards of the profile's Pinterest account, read live. */
    boards: (username: string) => this.request<Json & { success: true; boards: { id: string; name: string }[]; pinterest_account_used: string | null }>('GET', '/v1/pinterest/boards', { query: { profile_username: username } }),
    /** Creates a board on the profile's Pinterest account. PROTECTED boards are hidden from others but can be posted to. */
    createBoard: (username: string, name: string, opts: { description?: string; privacy?: 'PUBLIC' | 'PROTECTED' } = {}) =>
      this.request<Json & { board: { id: string; name: string } }>('POST', '/v1/pinterest/boards', { json: { profile_username: username, name, description: opts.description, privacy: opts.privacy } }),
    sections: (username: string, boardId: string) =>
      this.request<Json & { success: true; board_id: string; sections: { id: string; name: string }[] }>('GET', `/v1/pinterest/boards/${enc(boardId)}/sections`, { query: { profile_username: username } }),
    createSection: (username: string, boardId: string, name: string) =>
      this.request<Json & { success: true; board_id: string; section: { id: string; name: string } }>('POST', `/v1/pinterest/boards/${enc(boardId)}/sections`, { json: { profile_username: username, name } }),
    /** Saves (repins) a Pin to one of the account's boards. */
    savePin: (username: string, pinId: string, boardId: string, sectionId?: string) =>
      this.request<Json & { success: true; post_id: string; url: string; board_id: string; board_section_id: string | null; parent_pin_id: string | null }>('POST', '/v1/posts/save', {
        json: { profile_username: username, platform: 'pinterest', post_id: pinId, pinterest_board_id: boardId, pinterest_board_section_id: sectionId },
      }),
  };

  readonly analytics = {
    account: (username: string, platforms?: string[]) => this.request('GET', `/v1/analytics/${enc(username)}`, { query: { platforms } }),
    history: (username: string, query: { days?: number; platforms?: string[] } = {}) => this.request('GET', `/v1/analytics/${enc(username)}/history`, { query }),
    /** Stats of a post Reelspan published, by its request_id. */
    post: (requestId: string, platform?: string) => this.request('GET', `/v1/post-analytics/${enc(requestId)}`, { query: { platform } }),
    /** Stats of any post of the profile's account by the network's own post id, including posts made outside Reelspan. */
    postById: (username: string, platform: Platform | (string & {}), platformPostId: string) =>
      this.request<Json & { success: true; platform: string; platform_post_id: string; metrics: Json }>('GET', '/v1/post-analytics', { query: { profile_username: username, platform, platform_post_id: platformPostId } }),
    /**
     * Impressions and views (or other `metrics`) added up over the profile's posts in a period, per network and per
     * day: the last `days` (default 30), or `startDate` to `endDate` (YYYY-MM-DD, inclusive).
     */
    impressions: (username: string, query: { days?: number; startDate?: string; endDate?: string; platforms?: string[]; metrics?: string[] } = {}) =>
      this.request<Json & { success: true; profile_username: string; from: string; to: string; posts: number; posts_with_stats: number; total: Record<string, number>; by_platform: Record<string, Record<string, number>>; by_day: Record<string, string | number>[] }>(
        'GET',
        `/v1/analytics/${enc(username)}/impressions`,
        { query: { days: query.days, start_date: query.startDate, end_date: query.endDate, platforms: query.platforms, metrics: query.metrics } },
      ),
    bestTimes: (username: string, query: { timezone?: string; platforms?: string[] } = {}) => this.request('GET', `/v1/best-times/${enc(username)}`, { query }),
    report: (username: string, days = 30) => this.request('GET', `/v1/reports/${enc(username)}`, { query: { days } }),
  };

  /** Comments under posts, in one shape for every network that has them. */
  readonly comments = {
    /** Comments under a post (newest first where the network can sort), or replies to `commentId`. On X, no post lists the mentions. */
    list: (target: CommentTarget & { commentId?: string; held?: boolean; limit?: number; cursor?: string }) =>
      this.request<Json & { success: true; platform: string; comments: Comment[]; pagination: { next_cursor: string | null; has_next: boolean }; cached: boolean }>('GET', '/v1/comments', {
        query: { ...commentTarget(target), comment_id: target.commentId, held: target.held === undefined ? undefined : String(target.held), limit: target.limit, cursor: target.cursor },
      }),
    /** Every comment, page by page: `for await (const c of reelspan.comments.all({ platform: 'youtube', user, postId }))`. */
    all: (target: CommentTarget & { commentId?: string; held?: boolean }) => this.commentRows(target),
    /** Comments on the post, or replies to `commentId`. `attachmentUrl` puts an image under it on Facebook. */
    create: (target: CommentTarget & { message: string; commentId?: string; attachmentUrl?: string }) =>
      this.request<Json & { success: true; platform: string; id: string; url?: string | null }>('POST', '/v1/comments', {
        json: { ...commentTarget(target), message: target.message, comment_id: target.commentId, attachment_url: target.attachmentUrl },
      }),
    /** Replies to a comment in public. */
    reply: (target: CommentTarget & { commentId: string; message: string }) =>
      this.request<Json & { success: true; id: string }>('POST', '/v1/comments/public-reply', { json: { ...commentTarget(target), comment_id: target.commentId, message: target.message } }),
    /** Answers a comment with a direct message to its author (Instagram, under 7 days and once per comment; Facebook). */
    privateReply: (p: { platform: Platform | (string & {}); user: string; commentId: string; message: string; buttons?: LinkButton[] }) =>
      this.request<Json & { success: true; recipient_id: string | null; message_id: string | null }>('POST', '/v1/comments/reply', {
        json: { platform: p.platform, user: p.user, comment_id: p.commentId, message: p.message, buttons: p.buttons },
      }),
    /** Hides, likes, approves, holds, edits (with `message`) or bans the author of a comment; each network allows its own. */
    moderate: (target: CommentTarget & { action: CommentAction; commentId?: string; message?: string }) =>
      this.request<Json & { success: true; action: string }>('POST', '/v1/comments/action', { json: { ...commentTarget(target), action: target.action, comment_id: target.commentId, message: target.message } }),
    /** Your own comments; on Instagram, Facebook and YouTube any comment on your posts. LinkedIn needs the post too. */
    delete: (target: CommentTarget & { commentId: string }) =>
      this.request<Json & { success: true }>('DELETE', '/v1/comments', { json: { ...commentTarget(target), comment_id: target.commentId } }),
  };

  private async *commentRows(target: CommentTarget & { commentId?: string; held?: boolean }) {
    for (let cursor: string | undefined; ; ) {
      const r = await this.comments.list({ ...target, limit: 100, cursor });
      yield* r.comments;
      if (!r.pagination.has_next || !r.pagination.next_cursor || !r.comments.length) return;
      cursor = r.pagination.next_cursor;
    }
  }

  /** Direct messages. Instagram and Facebook answer only people who wrote to the account in the last 24 hours. */
  readonly dms = {
    /** Conversations, newest first, each with its latest messages. */
    conversations: (p: { platform: Platform | (string & {}); user: string; limit?: number; cursor?: string; participantId?: string; messagesLimit?: number }) =>
      this.request<Json & { success: true; platform: string; conversations: Json[]; pagination: { next_cursor: string | null; has_more: boolean } }>('GET', '/v1/dms/conversations', {
        query: { platform: p.platform, user: p.user, limit: p.limit, cursor: p.cursor, participant_id: p.participantId, messages_limit: p.messagesLimit },
      }),
    /** Sends a message. `recipientId`: the scoped user id on Instagram/Facebook, the user id on X, a handle or DID on Bluesky, @user@server on Mastodon. */
    send: (p: {
      platform: Platform | (string & {});
      user: string;
      recipientId: string;
      message: string;
      buttons?: LinkButton[];
      attachments?: { type: 'image' | 'video' | 'audio' | 'file'; url: string }[];
      quickReplies?: { title: string; payload?: string }[];
      replyTo?: string;
    }) =>
      this.request<Json & { success: true; platform: string; recipient_id: string; message_id: string | null }>('POST', '/v1/dms/send', {
        json: { platform: p.platform, user: p.user, recipient_id: p.recipientId, message: p.message, buttons: p.buttons, attachments: p.attachments, quick_replies: p.quickReplies, reply_to: p.replyTo },
      }),
  };

  /** AutoDM monitors: answer each new comment on a post, privately and/or in public, for 15 days. */
  readonly autodms = {
    /**
     * Starts a monitor on a post. `replyMessage` is the private reply (a DM to each commenter); `replyMessages` are
     * public replies used in turn, with `{username}` replaced. `triggerKeywords` answers only comments containing one.
     */
    start: (
      target: CommentTarget & {
        replyMessage?: string;
        replyMessages?: string[];
        buttons?: LinkButton[];
        triggerKeywords?: string[];
        /** Minutes between checks, 5 to 1440 (default 15) */
        monitoringInterval?: number;
        /** Also answer comments made in the 7 days before it started */
        includeExisting?: boolean;
      },
    ) =>
      this.request<Json & { success: true; monitor: AutoDmMonitor }>('POST', '/v1/autodms', {
        json: {
          ...commentTarget(target),
          reply_message: target.replyMessage,
          reply_messages: target.replyMessages,
          buttons: target.buttons,
          trigger_keywords: target.triggerKeywords,
          monitoring_interval: target.monitoringInterval,
          include_existing: target.includeExisting,
        },
      }),
    list: (query: { includeInactive?: boolean; user?: string; platform?: string } = {}) =>
      this.request<Json & { success: true; monitors: AutoDmMonitor[]; total_active: number; total: number }>('GET', '/v1/autodms', {
        query: { include_inactive: query.includeInactive === undefined ? undefined : String(query.includeInactive), profile_username: query.user, platform: query.platform },
      }),
    get: (monitorId: string) => this.request<Json & { success: true; monitor: AutoDmMonitor }>('GET', `/v1/autodms/${enc(monitorId)}`),
    /** What the monitor answered (and skipped), newest first. */
    logs: (monitorId: string, limit?: number) =>
      this.request<Json & { success: true; logs: { comment_id: string; author: string | null; text: string | null; kind: string; success: boolean; error: string | null; at: string }[] }>('GET', `/v1/autodms/${enc(monitorId)}/logs`, { query: { limit } }),
    pause: (monitorId: string) => this.request<Json & { success: true; monitor: AutoDmMonitor }>('POST', `/v1/autodms/${enc(monitorId)}/pause`),
    resume: (monitorId: string) => this.request<Json & { success: true; monitor: AutoDmMonitor }>('POST', `/v1/autodms/${enc(monitorId)}/resume`),
    /** Stops the monitor for good. */
    stop: (monitorId: string) => this.request<Json & { success: true; monitor: AutoDmMonitor }>('POST', `/v1/autodms/${enc(monitorId)}/stop`),
    /** Checks a running monitor's post now instead of at the next interval. */
    check: (monitorId: string) => this.request<Json & { success: true; result: Json; monitor: AutoDmMonitor }>('POST', `/v1/autodms/${enc(monitorId)}/check`),
    /** Deletes the monitor and its logs. */
    delete: (monitorId: string) => this.request<Json & { success: true }>('DELETE', `/v1/autodms/${enc(monitorId)}`),
  };

  /** Published YouTube videos: subtitle tracks and thumbnails. */
  readonly youtube = {
    subtitles: {
      list: (video: YouTubeVideo) => this.request<Json & { success: true; video_id: string; subtitles: SubtitleTrack[] }>('GET', '/v1/youtube/subtitles', { query: ytVideo(video) }),
      /** Adds a track from a `file` (SRT, VTT, SBV…, up to 5 MB), its `text`, or a public `url`. `language` is BCP-47: en, ur, pt-BR… */
      add: (video: YouTubeVideo & { language: string; name?: string; file?: Exclude<FileInput, string>; text?: string; url?: string }) => {
        const fields = { ...ytVideo(video), language: video.language, name: video.name, subtitle_text: video.text, subtitle_url: video.url };
        if (video.file === undefined) return this.request<Json & { success: true; video_id: string; subtitle: SubtitleTrack }>('POST', '/v1/youtube/subtitles', { json: fields });
        const form = new FormData();
        appendFields(form, fields);
        appendFile(form, 'subtitles', video.file);
        return this.request<Json & { success: true; video_id: string; subtitle: SubtitleTrack }>('POST', '/v1/youtube/subtitles', { form });
      },
      delete: (video: YouTubeVideo & { subtitleId: string }) =>
        this.request<Json & { success: true; video_id: string; subtitle_id: string }>('DELETE', '/v1/youtube/subtitles', { json: { ...ytVideo(video), subtitle_id: video.subtitleId } }),
    },
    /**
     * Sets a new thumbnail (JPEG, PNG, GIF or BMP up to 2 MB) from a file, bytes or public URL, or `mediaId` from
     * media.upload. Needs a verified channel; Shorts don't show custom thumbnails.
     */
    setThumbnail: (video: YouTubeVideo & { thumbnail?: FileInput; mediaId?: string }) => {
      type R = Json & { success: true; video_id: string; width: number | null; height: number | null; thumbnails: Json };
      if (video.thumbnail === undefined || typeof video.thumbnail === 'string')
        return this.request<R>('POST', '/v1/youtube/thumbnail', { json: { ...ytVideo(video), thumbnail_url: video.thumbnail, thumbnail_media_id: video.mediaId } });
      const form = new FormData();
      appendFields(form, ytVideo(video));
      appendFile(form, 'thumbnail', video.thumbnail);
      return this.request<R>('POST', '/v1/youtube/thumbnail', { form });
    },
  };

  /** The Facebook Pages connected to a profile, and which one posts go to. */
  readonly facebook = {
    pages: (username: string) =>
      this.request<Json & { success: true; pages: { id: string; name: string; picture: string | null; account_id: string; selected: boolean; followers: number | null; likes: number | null }[]; selected_page_id: string | null; selected_page_name: string | null }>(
        'GET',
        '/v1/facebook/pages',
        { query: { profile_username: username } },
      ),
    /** The Page used when a post sends no facebook_page_id. */
    selectPage: (username: string, pageId: string) =>
      this.request<Json & { success: true; facebook_page_id: string; facebook_page_name: string }>('POST', '/v1/facebook/page', { json: { profile_username: username, facebook_page_id: pageId } }),
    clearPage: (username: string) => this.request<Json & { success: true }>('DELETE', '/v1/facebook/page', { json: { profile_username: username } }),
    /** A Page's about, website, phone, hours, category, picture and cover (default: the chosen Page). */
    pageInfo: (username: string, pageId?: string) => this.request<Json & { success: true; page_id: string; page: Json }>('GET', '/v1/facebook/page-info', { query: { profile_username: username, page_id: pageId } }),
    /** Changes a Page's details; `validateOnly` reports what would change without saving. */
    updatePageInfo: (
      username: string,
      info: { pageId?: string; validateOnly?: boolean; about?: string; description?: string; website?: string; phone?: string; emails?: string[]; hours?: Record<string, string>; [field: string]: unknown },
    ) => {
      const { pageId, validateOnly, ...fields } = info;
      return this.request('PATCH', '/v1/facebook/page-info', { json: { profile_username: username, page_id: pageId, validate_only: validateOnly, ...fields } });
    },
  };

  /** LinkedIn company pages the profile's member administers, and which one posts go out as. */
  readonly linkedin = {
    pages: (username: string) =>
      this.request<Json & { success: true; pages: { id: string; urn: string; name: string; vanity_name: string | null; picture: string | null; followers: number | null; selected: boolean }[]; selected_page_id: string | null; selected_page_name: string | null }>(
        'GET',
        '/v1/linkedin/pages',
        { query: { profile_username: username } },
      ),
    /** Posts with no target_linkedin_page_id go out as this page. */
    selectPage: (username: string, pageId: string) =>
      this.request<Json & { success: true; linkedin_page_id: string; linkedin_page_name: string }>('POST', '/v1/linkedin/page', { json: { profile_username: username, linkedin_page_id: pageId } }),
    /** Posts go out as the member again. */
    clearPage: (username: string) => this.request<Json & { success: true }>('DELETE', '/v1/linkedin/page', { json: { profile_username: username } }),
  };

  /** Google Business locations, and which one posts go to. */
  readonly googleBusiness = {
    /** As saved when the account was connected; `refresh` reads them again from Google. */
    locations: (username: string, opts: { refresh?: boolean } = {}) =>
      this.request<Json & { success: true; locations: { id: string; name: string; title: string; account_id: string; selected: boolean }[]; selected_location_id: string | null; selected_location_name: string | null }>(
        'GET',
        '/v1/google-business/locations',
        { query: { profile_username: username, refresh: opts.refresh ? 'true' : undefined } },
      ),
    selectLocation: (username: string, locationId: string) =>
      this.request<Json & { success: true; location_id: string; location_name: string }>('POST', '/v1/google-business/location', { json: { profile_username: username, location_id: locationId } }),
    clearLocation: (username: string) => this.request<Json & { success: true }>('DELETE', '/v1/google-business/location', { json: { profile_username: username } }),
  };

  readonly tiktok = {
    /** What the profile's TikTok account may post: privacy levels, interactions and its longest video. */
    creatorInfo: (username: string) => this.request<Json & { success: true }>('GET', '/v1/tiktok/creator-info', { query: { profile_username: username } }),
  };

  readonly reddit = {
    /** The account's Reddit posts with score, comments, views and media (`source` says whether from Reddit or Reelspan). Page with `after`. */
    posts: (username: string, query: { limit?: number; after?: string } = {}) =>
      this.request<Json & { success: true; source: 'account' | 'reelspan'; posts: Json[]; after: string | null }>('GET', '/v1/reddit/posts', { query: { profile_username: username, ...query } }),
  };

  /** What a profile's Instagram and Threads accounts may still post in the next 24 hours, read live. */
  publishingLimits(username: string, opts: { platform?: 'instagram' | 'threads'; refresh?: boolean } = {}) {
    type Read = { limit_reached: boolean; fetched_at: string; cached: boolean };
    return this.request<Json & { success: true; limits: { instagram?: Read & { posts: LimitWindow }; threads?: Read & { posts: LimitWindow; replies: LimitWindow } }; errors?: Record<string, { error: string; error_code: string }> }>(
      'GET',
      '/v1/publishing-limits',
      { query: { profile_username: username, platform: opts.platform, refresh: opts.refresh ? 'true' : undefined } },
    );
  }

  /** Features that wait for a network's approval, and which are live. */
  permissions() {
    return this.request<Json & { success: true; permissions: { id: string; platform: string; unlocks: string; approval: string; scopes: string[]; status: 'live' | 'pending' }[] }>('GET', '/v1/permissions');
  }

  /** The workspace's activity log, newest first: what was done and by whom (a team member, an API key or Reelspan). */
  activity(query: { limit?: number; before?: string; profile?: string; type?: ActivityType } = {}) {
    return this.request<Json & { success: true; activity: ActivityEntry[]; next_cursor: string | null }>('GET', '/v1/activity', { query });
  }

  /** Workspace preferences: the first day of the week, and the zone scheduled_date is read in when a post sends none. */
  readonly preferences = {
    get: () => this.request<Json & { success: true; preferences: Preferences }>('GET', '/v1/preferences'),
    /** Send only what changes; `timezone: null` goes back to UTC. */
    set: (prefs: Partial<Preferences>) => this.request<Json & { success: true; preferences: Preferences }>('POST', '/v1/preferences', { json: prefs }),
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
