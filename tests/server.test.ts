/** The HTTP + MCP layer end to end, in process, against the fake YouTube: no quota spent. */

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type App, createApp, DESCRIPTION, VIDEO_DATA_DESCRIPTION } from "../src/server.ts";
import { FakeYouTube, RECORDED } from "./fake-youtube.ts";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function connect(app: App): Promise<Client> {
  const client = new Client({ name: "test", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://server.test/mcp"), {
    fetch: (url, init) => app.fetch(new Request(url, init)),
  });
  await client.connect(transport);
  return client;
}

/** The JSON-RPC message in a 2025-era reply, which the SDK's fallback sends as one SSE event. */
async function sseMessage(response: Response): Promise<any> {
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data:"));
  return JSON.parse(data?.slice("data:".length) ?? "null");
}

/** The videos in a tool result: its one text block holds them as JSON. */
function videosOf(result: { content: unknown }): any[] {
  return JSON.parse((result.content as any)[0].text);
}

function legacyPost(app: App, body: object): Promise<Response> {
  return app.fetch(
    new Request("http://server.test/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
    }),
  );
}

describe("http routes", () => {
  const app = createApp("k", { fetch: new FakeYouTube(RECORDED).fetch });

  test("health is ok", async () => {
    const response = await app.fetch(new Request("http://server.test/health"));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  test("unknown path is 404", async () => {
    expect((await app.fetch(new Request("http://server.test/nope"))).status).toBe(404);
  });

  test("missing key refuses to start", () => {
    expect(() => createApp("  ")).toThrow("YOUTUBE_API_KEY is not set");
  });
});

describe("mcp", () => {
  test("lists both tools with their contracts", async () => {
    const client = await connect(createApp("k", { fetch: new FakeYouTube(RECORDED).fetch }));

    const tools = Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t]));

    expect(tools.search_youtube.description).toBe(DESCRIPTION);
    expect(tools.search_youtube.inputSchema.required).toEqual(["query"]);
    expect(tools.search_youtube.outputSchema).toBeUndefined();
    expect(tools.get_video_data.description).toBe(VIDEO_DATA_DESCRIPTION);
    expect(tools.get_video_data.inputSchema.required).toEqual(["videos"]);
    await client.close();
  });

  test("search_youtube returns the videos as JSON text", async () => {
    const client = await connect(createApp("k", { fetch: new FakeYouTube(RECORDED).fetch }));

    const result = await client.callTool({
      name: "search_youtube",
      arguments: { query: "cooking" },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    expect(result.structuredContent).toBeUndefined();
    expect(videosOf(result)).toHaveLength(7);
    await client.close();
  });

  test("get_video_data returns the videos as JSON text", async () => {
    const [id] = Object.keys(RECORDED.videos);
    const client = await connect(createApp("k", { fetch: new FakeYouTube(RECORDED).fetch }));

    const result = await client.callTool({
      name: "get_video_data",
      arguments: { videos: [`https://youtu.be/${id}`] },
    });

    expect(videosOf(result).map((v) => v.id)).toEqual([id]);
    await client.close();
  });

  test("a tool error reaches the client with its message", async () => {
    const client = await connect(createApp("k", { fetch: new FakeYouTube(RECORDED).fetch }));

    const result = await client.callTool({ name: "search_youtube", arguments: { query: " " } });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "The query is empty; pass a search string." },
    ]);
    await client.close();
  });

  test("an unexpected error reaches the client bare", async () => {
    // A malformed success body makes parsing throw a plain TypeError, not a YouTubeError.
    const client = await connect(
      createApp("k", { fetch: async () => Response.json({ items: 5 }) }),
    );

    const result = await client.callTool({
      name: "get_video_data",
      arguments: { videos: ["dQw4w9WgXcQ"] },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Error executing tool get_video_data" }]);
    await client.close();
  });

  test("a 2025-era client is served statelessly", async () => {
    const app = createApp("k", { fetch: new FakeYouTube(RECORDED).fetch });

    const response = await legacyPost(app, {
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "old", version: "0" },
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/^text\/event-stream/);
    expect((await sseMessage(response)).result.serverInfo.name).toBe("youtube-search");
  });

  test("a 2025-era tool call needs no initialize", async () => {
    const app = createApp("k", { fetch: new FakeYouTube(RECORDED).fetch });

    const response = await legacyPost(app, {
      method: "tools/call",
      params: { name: "search_youtube", arguments: { query: "cooking" } },
    });

    expect(videosOf((await sseMessage(response)).result)).toHaveLength(7);
  });
});
