import { readFileSync } from "node:fs";
import { YouTubeClient } from "../src/youtube.ts";

export const RECORDED = JSON.parse(
  readFileSync(new URL("./fixtures/recorded_responses.json", import.meta.url), "utf-8"),
);

export type Call = string; // "search relevance p1", "search viewCount p2", "videos"

/**
 * Serves search pages and video records from a world shaped like the recorded fixture.
 *
 * `{"queries": {q: {order: {"p1": page, "p2": page | null}}}, "videos": {id: resource}}`
 * A page-2 request is recognised by the page-1 `nextPageToken` of the same query and order.
 */
export class FakeYouTube {
  readonly calls: Call[] = [];
  private readonly world: any;
  private readonly fail: Record<Call, () => Response>;

  constructor(world: any, fail: Record<Call, () => Response> = {}) {
    this.world = world;
    this.fail = fail;
  }

  fetch = async (input: string): Promise<Response> => {
    const url = new URL(input);
    const params = url.searchParams;
    let call: Call;
    let body: unknown;
    if (url.pathname.endsWith("/search")) {
      const pages = this.world.queries[params.get("q") ?? ""][params.get("order") ?? ""];
      const page = params.has("pageToken") ? "p2" : "p1";
      if (page === "p2" && params.get("pageToken") !== pages.p1.nextPageToken) {
        throw new Error(`unexpected page token ${params.get("pageToken")}`);
      }
      call = `search ${params.get("order")} ${page}`;
      body = pages[page];
    } else {
      call = "videos";
      const records = this.world.videos;
      const ids = (params.get("id") ?? "").split(",");
      body = { items: ids.filter((i) => i in records).map((i) => records[i]) };
    }
    this.calls.push(call);
    return this.fail[call]?.() ?? Response.json(body);
  };

  searches(): Call[] {
    return this.calls.filter((c) => c.startsWith("search"));
  }
}

export function client(fake: { fetch: FakeYouTube["fetch"] }): YouTubeClient {
  return new YouTubeClient("k", { fetch: fake.fetch, sleep: async () => {} });
}

// --- hand-written worlds -------------------------------------------------------------------

export function item(videoId: string, title?: string) {
  const snippet = {
    title: title ?? `search title ${videoId}`,
    channelTitle: "Snippet Channel",
    publishedAt: "2020-01-01T00:00:00Z",
    description: "truncated search description ...",
  };
  return { id: { kind: "youtube#video", videoId }, snippet };
}

export function resource(videoId: string, duration = "PT4M5S", views: string | null = "1000") {
  const record: Record<string, unknown> = {
    id: videoId,
    snippet: {
      title: `title ${videoId}`,
      channelTitle: "Channel",
      publishedAt: "2024-01-01T00:00:00Z",
      description: "the full description",
    },
    contentDetails: { duration },
  };
  if (views !== null) record.statistics = { viewCount: views };
  return record;
}

function page(ids: string, token?: string) {
  const body: Record<string, unknown> = { items: [...ids].map((i) => item(i)) };
  if (token) body.nextPageToken = token;
  return body;
}

type Side = [p1: string, p2: string | null];

/** relevance/popularity: [p1 ids, p2 ids | null], one character per id. Videos default to every id seen. */
export function world(relevance: Side, popularity: Side, videos?: Record<string, unknown>) {
  const pages = ([p1, p2]: Side) => ({
    p1: page(p1, p2 !== null ? "NEXT" : undefined),
    p2: p2 && page(p2),
  });
  const allIds = new Set([...relevance.join(""), ...popularity.join("")]);
  return {
    queries: { q: { relevance: pages(relevance), viewCount: pages(popularity) } },
    videos: videos ?? Object.fromEntries([...allIds].map((i) => [i, resource(i)])),
  };
}
