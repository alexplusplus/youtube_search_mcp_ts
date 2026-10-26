import { expect, test } from "vitest";
import { needsFallback, normalise, overlap, type SearchItem } from "../src/overlap.ts";

function item(videoId: string): SearchItem {
  return { id: { kind: "youtube#video", videoId }, snippet: { title: videoId } };
}

function ids(items: SearchItem[]): string[] {
  return items.map((i) => i.id.videoId);
}

test("normalise drops items without video id", () => {
  const items = [item("a"), { id: { kind: "youtube#channel", channelId: "c" } }, {}, item("b")];

  expect(ids(normalise(items))).toEqual(["a", "b"]);
});

test("normalise keeps first occurrence and its order", () => {
  const firstA = item("a");
  const items = [item("b"), firstA, item("b"), item("c"), item("a")];

  const result = normalise(items);

  expect(ids(result)).toEqual(["b", "a", "c"]);
  expect(result[1]).toBe(firstA);
});

test("overlap is ordered by relevance rank", () => {
  const relevance = [..."abcdef"].map(item);
  const popularity = [..."fxbyd"].map(item);

  expect(ids(overlap(relevance, popularity))).toEqual(["b", "d", "f"]);
});

test("overlap keeps the relevance list entry", () => {
  const relB = item("b");

  expect(overlap([relB], [item("b")])[0]).toBe(relB);
});

test("zero overlap is empty", () => {
  expect(overlap([item("a")], [item("b")])).toEqual([]);
});

test("fallback is needed below five videos", () => {
  expect(needsFallback([..."abcd"].map(item))).toBe(true);
  expect(needsFallback([..."abcde"].map(item))).toBe(false);
  expect(needsFallback([])).toBe(true);
});
