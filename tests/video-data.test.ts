import { beforeEach, expect, test, vi } from "vitest";
import type { Fields } from "../src/description.ts";
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

test("descriptions are cleaned the same way as in search", async () => {
  // Anchors on the description's first character: only its first line is kept.
  const extract = vi.fn(async (state: string, fields: Fields) => {
    const header = "Video description:\n";
    const at = Array.from(state.slice(0, state.indexOf(header) + header.length)).length;
    const anchor = { value: "x", span: [at, at + 1] as [number, number] };
    return Object.fromEntries(Object.keys(fields).map((field) => [field, anchor]));
  });
  // A multi-line description without chapter lines, which cleaning would keep.
  const id = Object.keys(RECORDED).find((key) => {
    const text: string = RECORDED[key].snippet.description ?? "";
    return text.trim().includes("\n") && !/^\s*[([]?\d{1,2}:\d{2}/m.test(text);
  }) as string;
  const original = videoFromResource(RECORDED[id]);
  expect(original.description?.trim()).toContain("\n"); // multi-line, so cleaning shows

  const [video] = await videoData([id], client([]), { extract });

  expect(extract).toHaveBeenCalledOnce();
  expect(video).toEqual({ ...original, description: original.description?.split("\n")[0].trim() });
});

test("a failing extractor returns the original description", async () => {
  const extract = async () => {
    throw new Error("AI down");
  };

  expect(await videoData([A, B], client([]), { extract })).toEqual(
    await videoData([A, B], client([])),
  );
});
