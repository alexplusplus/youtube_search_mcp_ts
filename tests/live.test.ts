/**
 * Opt-in end-to-end test against real YouTube through the in-process MCP client.
 *
 * Costs 2–4 of the 100 searches/day: `npm run test:live` (reads YOUTUBE_API_KEY from .env).
 */

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, test } from "vitest";
import { createApp, DESCRIPTION } from "../src/server.ts";

const key = process.env.YOUTUBE_API_KEY;

test.skipIf(!key)("search_youtube end to end", { timeout: 60_000 }, async () => {
  const app = createApp(key ?? "");
  const client = new Client({ name: "live-test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://server.test/mcp"), {
      fetch: (url, init) => app.fetch(new Request(url, init)),
    }),
  );

  const tool = (await client.listTools()).tools.find((t) => t.name === "search_youtube");
  expect(tool?.description).toBe(DESCRIPTION);
  expect(tool?.inputSchema.required).toEqual(["query"]);

  const result = await client.callTool({
    name: "search_youtube",
    arguments: { query: "python asyncio tutorial" },
  });
  await client.close();

  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  const videos: any[] = JSON.parse((result.content as any)[0].text);
  expect(videos.length).toBeGreaterThan(0);
  for (const video of videos) {
    expect(video.url).toBe(`https://youtu.be/${video.id}`);
    expect(video.views === null || Number.isInteger(video.views)).toBe(true);
    expect(video.length === null || /^\d+:\d\d(:\d\d)?$/.test(video.length)).toBe(true);
  }
});
