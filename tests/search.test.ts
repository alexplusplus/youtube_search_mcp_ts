import { afterEach, beforeEach, describe, expect, type MockInstance, test, vi } from "vitest";
import { search, ToolError } from "../src/tools.ts";
import { client, FakeYouTube, RECORDED, resource, world } from "./fake-youtube.ts";

let consoleLog: MockInstance<typeof console.log>;

beforeEach(() => {
  consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  consoleLog.mockRestore();
});

function logLines(): any[] {
  return consoleLog.mock.calls.map(([line]) => JSON.parse(line));
}

async function toolError(promise: Promise<unknown>): Promise<ToolError> {
  const caught = await promise.then(
    () => {
      throw new Error("expected a ToolError");
    },
    (e: unknown) => e,
  );
  expect(caught).toBeInstanceOf(ToolError);
  return caught as ToolError;
}

describe("recorded queries", () => {
  test.each([
    ["python asyncio taskgroup tutorial", 13],
    ["cooking", 7],
    ["lofi hip hop", 17],
    ["spacex starship launch", 6],
  ])("page-one overlap of five or more needs no fallback: %s", async (query, size) => {
    const fake = new FakeYouTube(RECORDED);

    const videos = await search(query, client(fake));

    expect(videos).toHaveLength(size);
    expect(fake.searches()).toHaveLength(2);
    expect(fake.calls.filter((c) => c === "videos")).toHaveLength(1);
  });

  test("small page-one overlap falls back to both second pages", async () => {
    const fake = new FakeYouTube(RECORDED);

    const videos = await search("cloud run deployment", client(fake));

    expect(videos).toHaveLength(16);
    expect(fake.searches().sort()).toEqual([
      "search relevance p1",
      "search relevance p2",
      "search viewCount p1",
      "search viewCount p2",
    ]);
  });

  test("overlap is in relevance order", async () => {
    const query = "lofi hip hop";
    const relevanceIds: string[] = RECORDED.queries[query].relevance.p1.items.map(
      (item: any) => item.id.videoId,
    );

    const videos = await search(query, client(new FakeYouTube(RECORDED)));

    const positions = videos.map((v) => relevanceIds.indexOf(v.id));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  test("recorded videos have the output formats", async () => {
    const videos = await search(
      "python asyncio taskgroup tutorial",
      client(new FakeYouTube(RECORDED)),
    );

    for (const video of videos) {
      expect(video.url).toBe(`https://youtu.be/${video.id}`);
      expect(Number.isInteger(video.views)).toBe(true);
      expect(video.length).toMatch(/^(\d+:\d\d|\d+:\d\d:\d\d)$/);
      expect(video.title && video.channel && video.published_at?.endsWith("Z")).toBe(true);
    }
    // Full, not the truncated snippet.
    expect(Math.max(...videos.map((v) => v.description?.length ?? 0))).toBeGreaterThan(200);
  });

  test("live streams have no length", async () => {
    const videos = await search("lofi hip hop", client(new FakeYouTube(RECORDED)));

    expect(videos.some((v) => v.length === null)).toBe(true);
  });
});

describe("hand-written worlds", () => {
  test("hand-written fields", async () => {
    const w = world(["abcde", null], ["edcba", null]);
    w.videos.a = resource("a", "PT1H2M3S", "42");

    const videos = await search("q", client(new FakeYouTube(w)));

    expect(videos[0]).toEqual({
      id: "a",
      url: "https://youtu.be/a",
      title: "title a",
      channel: "Channel",
      views: 42,
      published_at: "2024-01-01T00:00:00Z",
      length: "1:02:03",
      description: "the full description",
    });
    expect(videos.slice(1).map((v) => v.length)).toEqual(Array(4).fill("4:05"));
  });

  test("hidden views and P0D length are null", async () => {
    const w = world(["abcde", null], ["abcde", null]);
    w.videos.b = resource("b", undefined, null);
    w.videos.c = resource("c", "P0D");

    const videos = new Map(
      (await search("q", client(new FakeYouTube(w)))).map((v) => [v.id, v] as const),
    );

    expect(videos.get("b")).toMatchObject({ views: null, length: "4:05" });
    expect(videos.get("c")).toMatchObject({ length: null, views: 1000 });
  });

  test("vanished video is filled from its relevance snippet in place", async () => {
    const w = world(["abcde", null], ["abcde", null]);
    delete w.videos.c;

    const videos = await search("q", client(new FakeYouTube(w)));

    expect(videos.map((v) => v.id)).toEqual([..."abcde"]);
    expect(videos[2]).toEqual({
      id: "c",
      url: "https://youtu.be/c",
      title: "search title c",
      channel: "Snippet Channel",
      views: null,
      published_at: "2020-01-01T00:00:00Z",
      length: null,
      description: "truncated search description ...",
    });
  });

  test("fallback combines pages and dedupes", async () => {
    // p1 overlap {a}; page 2 brings b, c, d, e in; relevance p2 repeats a and b
    const w = world(["abxy", "abcde"], ["aqrs", "edcbt"]);

    const videos = await search("q", client(new FakeYouTube(w)));

    expect(videos.map((v) => v.id)).toEqual([..."abcde"]);
  });

  test("fallback skips a side without next page token", async () => {
    const w = world(["abcde", "fghij"], ["aj", null]);

    const videos = await search("q", client(new FakeYouTube(w)));

    expect(videos.map((v) => v.id)).toEqual(["a", "j"]);
  });

  test("side without token makes no page-two call", async () => {
    const fake = new FakeYouTube(world(["abcde", "fghij"], ["aj", null]));

    await search("q", client(fake));

    expect(fake.searches().sort()).toEqual([
      "search relevance p1",
      "search relevance p2",
      "search viewCount p1",
    ]);
  });

  test("short overlap after fallback is an ordinary list", async () => {
    const videos = await search("q", client(new FakeYouTube(world(["ab", "c"], ["ba", "x"]))));

    expect(videos.map((v) => v.id)).toEqual(["a", "b"]);
  });

  test("zero overlap after fallback is a tool error", async () => {
    const fake = new FakeYouTube(world(["ab", "cd"], ["xy", "zw"]));

    const exc = await toolError(search("q", client(fake)));

    expect(exc.message).toBe(
      `No videos appear in both YouTube's relevance and view-count results for "q". ` +
        "Try a broader or differently worded query.",
    );
    expect(fake.searches()).toHaveLength(4);
    expect(fake.calls).not.toContain("videos");
  });

  test.each(["", "   ", "\t\n"])(
    "blank query %j is rejected before any YouTube call",
    async (query) => {
      const fake = new FakeYouTube(world(["a", null], ["a", null]));

      const exc = await toolError(search(query, client(fake)));

      expect(exc.message).toBe("The query is empty; pass a search string.");
      expect(fake.calls).toEqual([]);
    },
  );
});

function quota(): Response {
  return Response.json({ error: { errors: [{ reason: "quotaExceeded" }] } }, { status: 403 });
}

describe("failures", () => {
  test("YouTube failure becomes a tool error with status and reason", async () => {
    const fake = new FakeYouTube(world(["abcde", null], ["abcde", null]), {
      "search viewCount p1": quota,
    });

    const exc = await toolError(search("q", client(fake)));

    expect(exc.message).toBe(
      "YouTube API daily quota is exhausted; it resets at midnight Pacific time. " +
        "[403 quotaExceeded]",
    );
  });

  test("page-two failure fails the whole call", async () => {
    const fake = new FakeYouTube(world(["ab", "cde"], ["ba", "edc"]), {
      "search relevance p2": () => Response.json({ error: {} }, { status: 400 }),
    });

    const exc = await toolError(search("q", client(fake)));

    expect(exc.message).toBe("YouTube rejected the request. [400]");
  });

  test("videos failure after searches fails the whole call", async () => {
    const fake = new FakeYouTube(world(["abcde", null], ["abcde", null]), {
      videos: () =>
        Response.json({ error: { errors: [{ reason: "backendError" }] } }, { status: 503 }),
    });

    const exc = await toolError(search("q", client(fake)));

    expect(exc.message).toMatch(/unavailable right now.*\[503 backendError\]$/);
  });
});

describe("logging", () => {
  test("one structured log line per call", async () => {
    const w = world(["ab", "cde"], ["ba", "edc"]);
    delete w.videos.d;

    await search("q", client(new FakeYouTube(w)));

    const lines = logLines();
    expect(lines).toHaveLength(1);
    const [record] = lines;
    expect(record.query).toBe("q");
    expect([record.search_calls, record.fallback]).toEqual([4, true]);
    expect([record.overlap_size, record.vanished]).toEqual([5, 1]);
    expect(Number.isInteger(record.duration_ms)).toBe(true);
    expect(record).not.toHaveProperty("error_category");
    expect(record.severity).toBe("INFO");
  });

  test("failure log line has category, status and reason", async () => {
    const fake = new FakeYouTube(world(["abcde", null], ["abcde", null]), {
      "search relevance p1": quota,
    });

    await toolError(search("q", client(fake)));

    const [record] = logLines();
    expect([record.error_category, record.http_status, record.reason]).toEqual([
      "QUOTA",
      403,
      "quotaExceeded",
    ]);
    expect(record.severity).toBe("WARNING");
  });

  test("zero overlap log line", async () => {
    await toolError(search("q", client(new FakeYouTube(world(["ab", "cd"], ["xy", "zw"])))));

    const [record] = logLines();
    expect([record.error_category, record.overlap_size, record.search_calls]).toEqual([
      "NO_OVERLAP",
      0,
      4,
    ]);
  });
});
