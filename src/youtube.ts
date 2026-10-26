/** YouTube Data API v3 client over fetch: requests, retry, error classification and parsing. */

export const BASE_URL = "https://www.googleapis.com/youtube/v3/";
export const REQUEST_TIMEOUT = 10_000; // ms, total per attempt including reading the body
export const MAX_IDS_PER_CALL = 50;
export const MAX_RETRY_AFTER = 5_000; // ms
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);
const KEY_REASONS = new Set(["keyInvalid", "keyExpired", "accessNotConfigured"]);

export type Order = "relevance" | "viewCount";
export type Json = Record<string, any>;
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export const ERROR_MESSAGES = {
  QUOTA: "YouTube API daily quota is exhausted; it resets at midnight Pacific time.",
  KEY: "YouTube rejected the server's API key; the server configuration needs fixing.",
  REJECTED: "YouTube rejected the request.",
  UNAVAILABLE: "YouTube is unavailable right now; try again in a minute.",
  UNEXPECTED: "Unexpected YouTube error.",
} as const;

export type ErrorCategory = keyof typeof ERROR_MESSAGES;

export class YouTubeError extends Error {
  readonly category: ErrorCategory;
  readonly status: number | null;
  readonly reason: string | null;

  constructor(
    category: ErrorCategory,
    status: number | null,
    reason: string | null,
    options?: ErrorOptions,
  ) {
    const raw = [status, reason].filter((part) => part !== null).join(" ");
    super(raw ? `${ERROR_MESSAGES[category]} [${raw}]` : ERROR_MESSAGES[category], options);
    this.name = "YouTubeError";
    this.category = category;
    this.status = status;
    this.reason = reason;
  }
}

/**
 * Decide by status plus every reason given: YouTube can pair a generic legacy reason
 * (`badRequest`) with the specific ErrorInfo one (`API_KEY_INVALID`).
 */
export function classify(status: number | null, reasons: string[]): ErrorCategory {
  if (status === null || status >= 500 || status === 429) return "UNAVAILABLE";
  const lowered = reasons.map((r) => r.toLowerCase());
  if (status === 403 && lowered.some((r) => r.includes("quota") || r.includes("dailylimit"))) {
    return "QUOTA";
  }
  if (status === 403 && reasons.some((r) => RATE_LIMIT_REASONS.has(r))) return "UNAVAILABLE";
  if (
    reasons.some((r) => KEY_REASONS.has(r) || r.startsWith("API_KEY_")) ||
    status === 401 ||
    status === 403
  ) {
    return "KEY";
  }
  if (status === 400) return "REJECTED";
  return "UNEXPECTED";
}

/** `error.errors[0].reason`, then the ErrorInfo `error.details[].reason`; all optional. */
export function errorReasons(body: unknown): string[] {
  const reasons: string[] = [];
  const error = (body as Json | null)?.error || {};
  const errors = error.errors || [{}];
  const reason = errors[0]?.reason;
  if (reason && typeof reason === "string") reasons.push(reason);
  for (const detail of Array.isArray(error.details) ? error.details : []) {
    const type = detail?.["@type"];
    if (typeof type === "string" && type.endsWith("ErrorInfo") && detail.reason) {
      reasons.push(String(detail.reason));
      break;
    }
  }
  return reasons;
}

/** Network errors, timeouts, 5xx and rate limits: exactly what classifies as unavailable. */
export function isRetryable(status: number | null, reasons: string[]): boolean {
  return classify(status, reasons) === "UNAVAILABLE";
}

export interface YouTubeClientOptions {
  fetch?: Fetch;
  retryDelay?: number; // ms
  sleep?: (ms: number) => Promise<unknown>;
  requestTimeout?: number; // ms
}

export class YouTubeClient {
  private readonly fetch: Fetch;
  private readonly headers: Record<string, string>;
  private readonly retryDelay: number;
  private readonly sleep: (ms: number) => Promise<unknown>;
  private readonly requestTimeout: number;

  constructor(apiKey: string, options: YouTubeClientOptions = {}) {
    // Wrapped, not stored bare: Workers throw "Illegal invocation" when the global fetch is
    // called as a method of another object.
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.headers = { "X-Goog-Api-Key": apiKey };
    this.retryDelay = options.retryDelay ?? 1_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.requestTimeout = options.requestTimeout ?? REQUEST_TIMEOUT;
  }

  async searchPage(query: string, order: Order, pageToken?: string | null): Promise<Json> {
    const params: Record<string, string> = {
      part: "snippet",
      q: query,
      type: "video",
      maxResults: "50",
      order,
    };
    if (pageToken) params.pageToken = pageToken;
    return this.get("search", params);
  }

  /** `videos.list` resources by id; ids YouTube no longer lists are simply absent. */
  async videos(ids: string[]): Promise<Map<string, Json>> {
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += MAX_IDS_PER_CALL) {
      chunks.push(ids.slice(i, i + MAX_IDS_PER_CALL));
    }
    const pages = await Promise.all(
      chunks.map((c) =>
        this.get("videos", { part: "snippet,contentDetails,statistics", id: c.join(",") }),
      ),
    );
    return new Map(
      pages.flatMap((page) => (page.items ?? []).map((item: Json) => [item.id, item])),
    );
  }

  private async get(endpoint: string, params: Record<string, string>): Promise<Json> {
    try {
      return await this.attempt(endpoint, params);
    } catch (error) {
      if (!(error instanceof Retryable)) throw error;
      await this.sleep(error.delay ?? this.retryDelay);
    }
    try {
      return await this.attempt(endpoint, params);
    } catch (error) {
      throw error instanceof Retryable ? error.error : error;
    }
  }

  private async attempt(endpoint: string, params: Record<string, string>): Promise<Json> {
    const url = `${BASE_URL}${endpoint}?${new URLSearchParams(params)}`;
    let response: Response;
    let text: string;
    try {
      ({ response, text } = await withTimeout(this.requestTimeout, async (signal) => {
        const response = await this.fetch(url, { headers: this.headers, signal });
        return { response, text: await response.text() };
      }));
    } catch (cause) {
      throw new Retryable(new YouTubeError("UNAVAILABLE", null, null, { cause }), null);
    }
    const body = parseJson(text);
    if (response.ok) {
      if (body === undefined) throw new YouTubeError("UNEXPECTED", response.status, null);
      return body as Json;
    }
    const status = response.status;
    const reasons = errorReasons(body);
    const error = new YouTubeError(classify(status, reasons), status, reasons[0] ?? null);
    if (isRetryable(status, reasons)) throw new Retryable(error, retryAfter(response));
    throw error;
  }
}

class Retryable extends Error {
  readonly error: YouTubeError;
  readonly delay: number | null;

  constructor(error: YouTubeError, delay: number | null) {
    super(error.message);
    this.error = error;
    this.delay = delay;
  }
}

/**
 * `run` must settle within `ms`, body included: a response that keeps trickling in never trips
 * a connect or per-read timeout. The signal also aborts the underlying fetch.
 */
async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new DOMException(`no response within ${ms} ms`, "TimeoutError");
      controller.abort(error);
      reject(error);
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function retryAfter(response: Response): number | null {
  const header = response.headers.get("Retry-After")?.trim();
  if (!header) return null;
  const seconds = Number(header);
  return Number.isNaN(seconds) ? null : Math.min(seconds * 1000, MAX_RETRY_AFTER);
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const VIDEO_PATH_PREFIXES = new Set(["shorts", "embed", "live", "v"]);

/** The id in a bare video id or a youtu.be / youtube.com URL; null if there is none. */
export function parseVideoId(text: string): string | null {
  const trimmed = text.trim();
  if (VIDEO_ID.test(trimmed)) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  const host = ["www.", "m.", "music."].reduce(
    (h, prefix) => (h.startsWith(prefix) ? h.slice(prefix.length) : h),
    url.hostname,
  );
  const segments = url.pathname.split("/").filter(Boolean);
  let candidate: string;
  if (host === "youtu.be" && segments.length > 0) {
    candidate = segments[0];
  } else if (host === "youtube.com" && segments.length === 1 && segments[0] === "watch") {
    candidate = url.searchParams.get("v") ?? "";
  } else if (
    host === "youtube.com" &&
    segments.length >= 2 &&
    VIDEO_PATH_PREFIXES.has(segments[0])
  ) {
    candidate = segments[1];
  } else {
    return null;
  }
  return VIDEO_ID.test(candidate) ? candidate : null;
}

const DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/** ISO 8601 duration as `h:mm:ss` (≥ 1 hour) or `m:ss`; null for `P0D`, absent or unparsable. */
export function formatDuration(iso: string | null | undefined): string | null {
  const match = DURATION.exec(iso ?? "");
  if (!match) return null;
  const [days, hours, minutes, seconds] = match.slice(1).map((g) => Number(g ?? 0));
  const total = ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
  if (total === 0) return null;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

export function parseViews(count: unknown): number | null {
  if (typeof count === "number" && Number.isFinite(count)) return Math.trunc(count);
  if (typeof count === "string" && /^\s*[+-]?\d+\s*$/.test(count)) return Number(count);
  return null;
}

/** An enriched video: one entry of the overlap with its full details. */
export interface Video {
  id: string;
  url: string;
  title: string | null;
  channel: string | null;
  views: number | null;
  published_at: string | null;
  length: string | null;
  description: string | null;
}

export function videoFromResource(resource: Json): Video {
  const snippet = resource.snippet ?? {};
  return {
    id: resource.id,
    url: `https://youtu.be/${resource.id}`,
    title: snippet.title ?? null,
    channel: snippet.channelTitle ?? null,
    views: parseViews(resource.statistics?.viewCount),
    published_at: snippet.publishedAt ?? null,
    length: formatDuration(resource.contentDetails?.duration),
    description: snippet.description ?? null,
  };
}

/** A vanished video, filled from its relevance-list search snippet: no views or length. */
export function videoFromSearchResult(item: Json): Video {
  const snippet = item.snippet ?? {};
  const videoId = item.id.videoId;
  return {
    id: videoId,
    url: `https://youtu.be/${videoId}`,
    title: snippet.title ?? null,
    channel: snippet.channelTitle ?? null,
    views: null,
    published_at: snippet.publishedAt ?? null,
    length: null,
    description: snippet.description ?? null,
  };
}
