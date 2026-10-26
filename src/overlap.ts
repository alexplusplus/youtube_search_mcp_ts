/**
 * Pure overlap logic over search.list items: no I/O.
 *
 * Items are raw `search.list` results (`{"id": {"videoId": ...}, "snippet": {...}}`); they are
 * kept whole so a vanished video can still be filled from its relevance-list snippet.
 */

export type SearchItem = Record<string, any>;

export const FALLBACK_THRESHOLD = 5;

export function videoId(item: SearchItem): string | undefined {
  return item.id?.videoId || undefined;
}

/** Drop items without a video id, then dedupe, keeping each id's first occurrence. */
export function normalise(items: SearchItem[]): SearchItem[] {
  const seen = new Set<string>();
  const result: SearchItem[] = [];
  for (const item of items) {
    const vid = videoId(item);
    if (vid && !seen.has(vid)) {
      seen.add(vid);
      result.push(item);
    }
  }
  return result;
}

/** The relevance-list items whose ids also appear in the popularity list, in relevance order. */
export function overlap(relevance: SearchItem[], popularity: SearchItem[]): SearchItem[] {
  const popular = new Set(popularity.map(videoId));
  return relevance.filter((item) => popular.has(videoId(item)));
}

export function needsFallback(videos: SearchItem[]): boolean {
  return videos.length < FALLBACK_THRESHOLD;
}
