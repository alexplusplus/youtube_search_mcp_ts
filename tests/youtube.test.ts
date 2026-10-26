import { describe, expect, test } from "vitest";
import {
  type ErrorCategory,
  formatDuration,
  parseVideoId,
  videoFromResource,
  videoFromSearchResult,
  YouTubeClient,
  YouTubeError,
} from "../src/youtube.ts";

const KEY = "test-key-123";

type Answer = Response | Error | ((request: Request) => Response | Promise<Response>);

/** A fake fetch that answers from a queue (the last answer repeats) and records requests. */
class Recorder {
  readonly requests: Request[] = [];
  private readonly answers: Answer[];

  constructor(...answers: Answer[]) {
    this.answers = answers;
  }

  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const request = new Request(url, init);
    this.requests.push(request);
    const answer = this.answers.length > 1 ? this.answers.shift() : this.answers[0];
    if (answer instanceof Error) throw answer;
    if (typeof answer === "function") return answer(request);
    return (answer as Response).clone(); // a body reads once; the original stays unread
  };
}

function client(
  rec: { fetch: Recorder["fetch"] },
  sleeps?: number[],
  requestTimeout = 10_000,
): YouTubeClient {
  return new YouTubeClient(KEY, {
    fetch: rec.fetch,
    retryDelay: 1_000,
    sleep: async (ms) => {
      sleeps?.push(ms);
    },
    requestTimeout,
  });
}

function ok(body?: object): Response {
  return Response.json(body ?? { items: [] });
}

function error(
  status: number,
  reason?: string,
  detailsReason?: string,
  headers?: Record<string, string>,
): Response {
  const err: Record<string, unknown> = { code: status, message: "do not parse me" };
  if (reason) err.errors = [{ domain: "youtube", reason, message: "x" }];
  if (detailsReason) {
    err.details = [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: detailsReason }];
  }
  return Response.json({ error: err }, { status, headers });
}

async function failure(promise: Promise<unknown>): Promise<YouTubeError> {
  const caught = await promise.then(
    () => {
      throw new Error("expected a YouTubeError");
    },
    (e: unknown) => e,
  );
  expect(caught).toBeInstanceOf(YouTubeError);
  return caught as YouTubeError;
}

function params(request: Request): Record<string, string> {
  return Object.fromEntries(new URL(request.url).searchParams);
}

const connectError = () => new TypeError("fetch failed");
const readTimeout = () => new DOMException("slow", "TimeoutError");

describe("requests on the wire", () => {
  test("search page sends key in header and never in URL", async () => {
    const rec = new Recorder(ok());

    await client(rec).searchPage("cooking", "viewCount");

    const request = rec.requests[0];
    expect(request.headers.get("X-Goog-Api-Key")).toBe(KEY);
    expect(request.url).not.toContain(KEY);
    expect(params(request)).not.toHaveProperty("key");
  });

  test("search page params", async () => {
    const rec = new Recorder(ok({ items: [], nextPageToken: "T2" }));

    const page = await client(rec).searchPage("lofi hip hop", "relevance");

    expect(rec.requests[0].url.startsWith("https://www.googleapis.com/youtube/v3/search?")).toBe(
      true,
    );
    expect(params(rec.requests[0])).toEqual({
      part: "snippet",
      q: "lofi hip hop",
      type: "video",
      maxResults: "50",
      order: "relevance",
    });
    expect(page.nextPageToken).toBe("T2");
  });

  test("search page two sends page token", async () => {
    const rec = new Recorder(ok());

    await client(rec).searchPage("cooking", "viewCount", "CDIQAA");

    expect(params(rec.requests[0]).pageToken).toBe("CDIQAA");
  });

  test("videos are fetched in chunks of at most fifty", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `v${String(i).padStart(3, "0")}`);
    const rec = new Recorder((request) => {
      const url = new URL(request.url);
      expect(url.pathname).toBe("/youtube/v3/videos");
      expect(url.searchParams.get("part")).toBe("snippet,contentDetails,statistics");
      expect(request.headers.get("X-Goog-Api-Key")).toBe(KEY);
      const chunk = (url.searchParams.get("id") ?? "").split(",");
      return ok({ items: chunk.map((id) => ({ id })) });
    });

    const videos = await client(rec).videos(ids);

    const chunkSizes = rec.requests
      .map((r) => params(r).id.split(",").length)
      .sort((a, b) => a - b);
    expect(chunkSizes).toEqual([20, 50, 50]);
    expect([...videos.keys()].sort()).toEqual(ids);
  });

  test("videos with no ids makes no call", async () => {
    const rec = new Recorder(ok());

    expect((await client(rec).videos([])).size).toBe(0);
    expect(rec.requests).toEqual([]);
  });
});

describe("retry", () => {
  test.each([
    ["500", () => error(500, "internalError")],
    ["503", () => error(503, "backendError")],
    ["429", () => error(429)],
    ["403-rate", () => error(403, "rateLimitExceeded")],
    ["403-user-rate", () => error(403, "userRateLimitExceeded")],
    ["connect", connectError],
    ["timeout", readTimeout],
  ])("transient failure is retried once after the delay: %s", async (_, first) => {
    const rec = new Recorder(first(), ok({ items: [], marker: 1 }));
    const sleeps: number[] = [];

    const page = await client(rec, sleeps).searchPage("q", "relevance");

    expect(page.marker).toBe(1);
    expect(rec.requests).toHaveLength(2);
    expect(sleeps).toEqual([1_000]);
  });

  test("retry honours Retry-After capped at five seconds", async () => {
    const sleeps: number[] = [];
    let rec = new Recorder(error(429, undefined, undefined, { "Retry-After": "2" }), ok());
    await client(rec, sleeps).searchPage("q", "relevance");

    rec = new Recorder(error(429, undefined, undefined, { "Retry-After": "30" }), ok());
    await client(rec, sleeps).searchPage("q", "relevance");

    expect(sleeps).toEqual([2_000, 5_000]);
  });

  test("persistent server error fails after one retry", async () => {
    const rec = new Recorder(error(503, "backendError"));

    const exc = await failure(client(rec).searchPage("q", "relevance"));

    expect(rec.requests).toHaveLength(2);
    expect(exc.category).toBe("UNAVAILABLE");
    expect([exc.status, exc.reason]).toEqual([503, "backendError"]);
  });

  test("timeout after retry is unavailable without status", async () => {
    const rec = new Recorder(readTimeout());

    const exc = await failure(client(rec).searchPage("q", "relevance"));

    expect(rec.requests).toHaveLength(2);
    expect(exc.category).toBe("UNAVAILABLE");
    expect(exc.status).toBeNull();
    expect(exc.message).toBe("YouTube is unavailable right now; try again in a minute.");
  });

  test("request slower than the total timeout is retried then unavailable", async () => {
    // Ignores the abort signal, like a body that keeps trickling in.
    const calls: string[] = [];
    const slow = {
      fetch: async (url: string) => {
        calls.push(url);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return ok();
      },
    };

    const exc = await failure(client(slow, undefined, 50).searchPage("q", "relevance"));

    expect(calls).toHaveLength(2);
    expect(exc.category).toBe("UNAVAILABLE");
    expect(exc.status).toBeNull();
  });

  test("quota error is not retried even beside a rate limit reason", async () => {
    const rec = new Recorder(error(403, "rateLimitExceeded", "RESOURCE_QUOTA_EXCEEDED"));

    const exc = await failure(client(rec).searchPage("q", "relevance"));

    expect(exc.category).toBe("QUOTA");
    expect(rec.requests).toHaveLength(1);
  });

  test.each([
    ["quota", () => error(403, "quotaExceeded")],
    ["daily-limit", () => error(403, "dailyLimitExceeded")],
    ["400", () => error(400, "badRequest")],
  ])("quota and other 4xx are never retried: %s", async (_, response) => {
    const rec = new Recorder(response());

    await failure(client(rec).searchPage("q", "relevance"));

    expect(rec.requests).toHaveLength(1);
  });
});

describe("error classification", () => {
  test.each<[() => Response, ErrorCategory]>([
    [() => error(403, "quotaExceeded"), "QUOTA"],
    [() => error(403, "dailyLimitExceeded"), "QUOTA"],
    [() => error(403, undefined, "RESOURCE_QUOTA_EXCEEDED"), "QUOTA"],
    [() => error(400, "keyInvalid"), "KEY"],
    [() => error(400, "keyExpired"), "KEY"],
    [() => error(400, undefined, "API_KEY_INVALID"), "KEY"],
    [() => error(403, undefined, "API_KEY_SERVICE_BLOCKED"), "KEY"],
    [() => error(403, "accessNotConfigured"), "KEY"],
    [() => error(403, "forbidden"), "KEY"],
    [() => error(401), "KEY"],
    [() => error(400, "invalidPageToken"), "REJECTED"],
    [() => new Response("not json", { status: 400 }), "REJECTED"],
    [() => error(502), "UNAVAILABLE"],
    [() => error(429), "UNAVAILABLE"],
    [() => error(404, "notFound"), "UNEXPECTED"],
    [() => new Response("<html>", { status: 200 }), "UNEXPECTED"],
  ])("case %#", async (response, category) => {
    const exc = await failure(client(new Recorder(response())).searchPage("q", "relevance"));

    expect(exc.category).toBe(category);
  });

  test("reported reason prefers errors over ErrorInfo", async () => {
    const response = error(403, "quotaExceeded", "RESOURCE_QUOTA_EXCEEDED");

    const exc = await failure(client(new Recorder(response)).searchPage("q", "relevance"));

    expect(exc.reason).toBe("quotaExceeded");
  });

  test("invalid key is a key problem despite generic errors reason", async () => {
    // Real body YouTube returned for a bogus key (2026-10-23): the legacy reason is the
    // generic "badRequest"; only ErrorInfo says API_KEY_INVALID.
    const response = Response.json(
      {
        error: {
          code: 400,
          message: "API key not valid. Please pass a valid API key.",
          errors: [{ message: "...", domain: "global", reason: "badRequest" }],
          status: "INVALID_ARGUMENT",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason: "API_KEY_INVALID",
              domain: "googleapis.com",
              metadata: { service: "youtube.googleapis.com" },
            },
            { "@type": "type.googleapis.com/google.rpc.LocalizedMessage", message: "..." },
          ],
        },
      },
      { status: 400 },
    );

    const exc = await failure(client(new Recorder(response)).searchPage("q", "relevance"));

    expect(exc.category).toBe("KEY");
    expect(exc.message.endsWith("[400 badRequest]")).toBe(true);
  });

  test.each([
    [
      () => error(403, "quotaExceeded"),
      "YouTube API daily quota is exhausted; it resets at midnight Pacific time. " +
        "[403 quotaExceeded]",
    ],
    [
      () => error(400, "keyInvalid"),
      "YouTube rejected the server's API key; the server configuration needs fixing. " +
        "[400 keyInvalid]",
    ],
    [() => error(400), "YouTube rejected the request. [400]"],
    [
      () => error(500, "internalError"),
      "YouTube is unavailable right now; try again in a minute. [500 internalError]",
    ],
    [() => error(418, "teapot"), "Unexpected YouTube error. [418 teapot]"],
  ])("error message carries status and reason: %#", async (response, message) => {
    const exc = await failure(client(new Recorder(response())).searchPage("q", "relevance"));

    expect(exc.message).toBe(message);
  });

  test("error never contains the key", async () => {
    const exc = await failure(client(new Recorder(connectError())).searchPage("q", "relevance"));

    expect(exc.message).not.toContain(KEY);
    expect(String(exc.cause)).not.toContain(KEY);
  });
});

describe("parsing", () => {
  test.each([
    ["PT15M33S", "15:33"],
    ["PT1H2M3S", "1:02:03"],
    ["P1DT2H", "26:00:00"],
    ["PT45S", "0:45"],
    ["PT1H", "1:00:00"],
    ["PT59M59S", "59:59"],
    ["P0D", null],
    [null, null],
    ["garbage", null],
  ])("format duration %s", (iso, formatted) => {
    expect(formatDuration(iso)).toBe(formatted);
  });

  test("video from resource", () => {
    const resource = {
      id: "abc",
      snippet: {
        title: "T",
        channelTitle: "C",
        publishedAt: "2024-04-05T14:30:26Z",
        description: "full description",
      },
      contentDetails: { duration: "PT1H2M3S" },
      statistics: { viewCount: "1234567" },
    };

    expect(videoFromResource(resource)).toEqual({
      id: "abc",
      url: "https://youtu.be/abc",
      title: "T",
      channel: "C",
      views: 1234567,
      published_at: "2024-04-05T14:30:26Z",
      length: "1:02:03",
      description: "full description",
    });
  });

  test("video from resource with hidden views and live length", () => {
    const video = videoFromResource({ id: "abc", contentDetails: { duration: "P0D" } });

    expect([video.views, video.length, video.title]).toEqual([null, null, null]);
  });

  test("video from search result has no views or length", () => {
    const item = {
      id: { videoId: "gone" },
      snippet: {
        title: "Old title",
        channelTitle: "C",
        publishedAt: "2020-01-01T00:00:00Z",
        description: "truncated ...",
      },
    };

    expect(videoFromSearchResult(item)).toEqual({
      id: "gone",
      url: "https://youtu.be/gone",
      title: "Old title",
      channel: "C",
      views: null,
      published_at: "2020-01-01T00:00:00Z",
      length: null,
      description: "truncated ...",
    });
  });

  test.each([
    ["dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["  dQw4w9WgXcQ\n", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?t=42", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1", "dQw4w9WgXcQ"],
    ["m.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://music.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/live/dQw4w9WgXcQ?si=x", "dQw4w9WgXcQ"],
    ["", null],
    ["dQw4w9WgXc", null],
    ["https://vimeo.com/dQw4w9WgXcQ", null],
    ["https://www.youtube.com/watch?v=short", null],
    ["https://www.youtube.com/@channel", null],
  ])("parse video id %j", (text, expected) => {
    expect(parseVideoId(text)).toBe(expected);
  });
});
