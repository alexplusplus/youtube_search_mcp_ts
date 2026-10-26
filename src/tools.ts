/** The search_youtube and get_video_data tool bodies, which tests call directly without MCP. */

import { needsFallback, normalise, overlap, type SearchItem } from "./overlap.ts";
import {
  type Json,
  type Order,
  parseVideoId,
  type Video,
  videoFromResource,
  videoFromSearchResult,
  type YouTubeClient,
  YouTubeError,
} from "./youtube.ts";

/** A failure the client should read: its message reaches the client verbatim. */
export class ToolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ToolError";
  }
}

type Log = Record<string, unknown>;

/** One JSON log line per tool call; a YouTubeError leaves as a ToolError. */
async function logged<T>(tool: string, fields: Log, body: (log: Log) => Promise<T>): Promise<T> {
  const log: Log = { tool, ...fields };
  const started = performance.now();
  try {
    return await body(log);
  } catch (error) {
    if (error instanceof YouTubeError) {
      Object.assign(log, {
        error_category: error.category,
        http_status: error.status,
        reason: error.reason,
      });
      throw new ToolError(error.message, { cause: error });
    }
    throw error;
  } finally {
    log.duration_ms = Math.round(performance.now() - started);
    log.severity = "error_category" in log ? "WARNING" : "INFO";
    console.log(JSON.stringify(log));
  }
}

/** The tool body: the overlap of both orders for `query`, enriched. Throws ToolError. */
export function search(query: string, youtube: YouTubeClient): Promise<Video[]> {
  return logged("search_youtube", { query, search_calls: 0, fallback: false }, async (log) => {
    const videos = await searchOverlap(query.trim(), youtube, log);
    log.overlap_size = videos.length;
    return videos;
  });
}

async function searchOverlap(query: string, youtube: YouTubeClient, log: Log): Promise<Video[]> {
  if (!query) {
    log.error_category = "EMPTY_QUERY";
    throw new ToolError("The query is empty; pass a search string.");
  }

  log.search_calls = 2;
  const [relP1, popP1] = await Promise.all([
    youtube.searchPage(query, "relevance"),
    youtube.searchPage(query, "viewCount"),
  ]);
  let relevance: SearchItem[] = relP1.items ?? [];
  let popularity: SearchItem[] = popP1.items ?? [];
  let found = overlap(normalise(relevance), normalise(popularity));

  if (needsFallback(found)) {
    log.fallback = true;
    const relToken: string | undefined = relP1.nextPageToken;
    const popToken: string | undefined = popP1.nextPageToken;
    log.search_calls = 2 + Number(Boolean(relToken)) + Number(Boolean(popToken));
    const [relP2, popP2] = await Promise.all([
      pageTwo(youtube, query, "relevance", relToken),
      pageTwo(youtube, query, "viewCount", popToken),
    ]);
    relevance = [...relevance, ...(relP2.items ?? [])];
    popularity = [...popularity, ...(popP2.items ?? [])];
    found = overlap(normalise(relevance), normalise(popularity));
  }

  if (found.length === 0) {
    Object.assign(log, { overlap_size: 0, error_category: "NO_OVERLAP" });
    throw new ToolError(
      `No videos appear in both YouTube's relevance and view-count results for "${query}". ` +
        "Try a broader or differently worded query.",
    );
  }

  const ids: string[] = found.map((item) => item.id.videoId); // normalise() guarantees an id
  const resources = await youtube.videos(ids);
  log.vanished = ids.filter((vid) => !resources.has(vid)).length;
  return ids.map((vid, i) => {
    const resource = resources.get(vid);
    return resource ? videoFromResource(resource) : videoFromSearchResult(found[i]);
  });
}

function pageTwo(
  youtube: YouTubeClient,
  query: string,
  order: Order,
  token: string | undefined,
): Promise<Json> {
  return token ? youtube.searchPage(query, order, token) : Promise.resolve({});
}

/** The tool body: the videos YouTube still lists, in input order. Throws ToolError. */
export function videoData(videos: string[], youtube: YouTubeClient): Promise<Video[]> {
  return logged("get_video_data", { videos }, async (log) => {
    const ids = videoIds(videos, log);
    const resources = await youtube.videos(ids);
    const found = ids.flatMap((vid) => {
      const resource = resources.get(vid);
      return resource ? [videoFromResource(resource)] : [];
    });
    log.missing = ids.length - found.length;
    if (found.length === 0) {
      log.error_category = "NOT_FOUND";
      throw new ToolError(`YouTube has no public video with id ${ids.join(", ")}.`);
    }
    return found;
  });
}

/** Each entry's id, first occurrence kept; any entry without one fails the whole call. */
function videoIds(videos: string[], log: Log): string[] {
  if (videos.length === 0) {
    log.error_category = "INVALID_INPUT";
    throw new ToolError("No videos given; pass one or more video ids or URLs.");
  }
  const parsed = videos.map((video) => [video, parseVideoId(video)] as const);
  const bad = parsed.filter(([, vid]) => vid === null).map(([video]) => JSON.stringify(video));
  if (bad.length > 0) {
    log.error_category = "INVALID_INPUT";
    throw new ToolError(`Not a YouTube video id or URL: ${bad.join(", ")}.`);
  }
  return [...new Set(parsed.map(([, vid]) => vid as string))];
}
