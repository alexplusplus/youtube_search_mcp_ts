import { beforeEach, expect, test, vi } from "vitest";
import { ToolError, videoData } from "../src/tools.ts";
import { videoFromResource, YouTubeClient } from "../src/youtube.ts";
import { RECORDED as WORLD } from "./fake-youtube.ts";

const RECORDED: Record<string, any> = WORLD.videos;
const [A, B] = Object.keys(RECORDED);
const GONE = "gonegonegon";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  return () => vi.restoreAllMocks();
});

function client(requests: URL[]): YouTubeClient {
  return new YouTubeClient("k", {
    fetch: async (input) => {
      const url = new URL(input);
      requests.push(url);
      const ids = (url.searchParams.get("id") ?? "").split(",");
      return Response.json({ items: ids.filter((i) => i in RECORDED).map((i) => RECORDED[i]) });
    },
  });
}

test("found videos in input order, deduped, missing omitted", async () => {
  const requests: URL[] = [];

  const videos = await videoData([B, GONE, `https://youtu.be/${A}`, B], client(requests));

  expect(videos).toEqual([videoFromResource(RECORDED[B]), videoFromResource(RECORDED[A])]);
  expect(requests.map((r) => r.searchParams.get("id"))).toEqual([`${B},${GONE},${A}`]);
});

test("all missing is a tool error", async () => {
  const promise = videoData([GONE], client([]));

  await expect(promise).rejects.toThrow(ToolError);
  await expect(promise).rejects.toThrow(`YouTube has no public video with id ${GONE}.`);
});

test.each([[[]], [[A, "not a video"]]])(
  "bad input %j is rejected before any YouTube call",
  async (videos) => {
    const requests: URL[] = [];

    await expect(videoData(videos, client(requests))).rejects.toThrow(ToolError);

    expect(requests).toEqual([]);
  },
);
