/**
 * MCP server wiring, shared by both runtimes: the two tools and a web-standard fetch handler
 * serving /mcp and /health. node.ts (Cloud Run) and worker.ts (Cloudflare) only mount it.
 */

import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { search, ToolError, videoData } from "./tools.ts";
import { type Fetch, type Video, YouTubeClient } from "./youtube.ts";

export const DESCRIPTION =
  "Search YouTube for videos that are both relevant to the query and popular. Returns the " +
  "overlap of YouTube's relevance-ordered and view-count-ordered results (typically 5–30 " +
  "videos, sometimes fewer), ordered by relevance, each with title, channel, views, " +
  "publication date, length, full description and a short URL. Each call costs scarce daily " +
  "quota (about 25–50 calls/day), so prefer one well-formed query over many variations.";
export const VIDEO_DATA_DESCRIPTION =
  "Get full details of YouTube videos by id or URL: title, channel, views, publication date, " +
  "length, full description and short URL.";

export function createMcpServer(youtube: YouTubeClient): McpServer {
  const server = new McpServer({ name: "youtube-search", version: "0.1.0" });
  server.registerTool(
    "search_youtube",
    {
      description: DESCRIPTION,
      inputSchema: z.object({ query: z.string() }),
    },
    ({ query }) => respond("search_youtube", () => search(query, youtube)),
  );
  server.registerTool(
    "get_video_data",
    {
      description: VIDEO_DATA_DESCRIPTION,
      inputSchema: z.object({ videos: z.array(z.string()) }),
    },
    ({ videos }) => respond("get_video_data", () => videoData(videos, youtube)),
  );
  return server;
}

/**
 * The SDK sends any thrown error's message to the client. Only a ToolError's is meant for it;
 * anything else is logged and reaches the client as a bare "Error executing tool <name>".
 */
async function respond(tool: string, run: () => Promise<Video[]>) {
  let result: Video[];
  try {
    result = await run();
  } catch (error) {
    if (error instanceof ToolError) throw error;
    console.error(JSON.stringify({ tool, severity: "ERROR", error: String(error) }));
    throw new Error(`Error executing tool ${tool}`);
  }
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

export interface App {
  fetch(request: Request): Promise<Response>;
}

export function createApp(apiKey: string, options: { fetch?: Fetch } = {}): App {
  const key = apiKey.trim();
  if (!key) throw new Error("YOUTUBE_API_KEY is not set; refusing to start.");
  const youtube = new YouTubeClient(key, { fetch: options.fetch });
  // Stateless, one server instance per request. 2026-07-28 clients get plain JSON (no tool
  // emits notifications); 2025-era clients get the SDK's stateless fallback, which answers
  // with SSE. No Host/Origin allowlist: Cloud Run and Workers own the Host header, and an
  // allowlist breaks on a rename.
  const mcp = createMcpHandler(() => createMcpServer(youtube));

  return {
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/mcp") return mcp.fetch(request);
      if (pathname === "/health") {
        return request.method === "GET"
          ? new Response("ok", { headers: { "Content-Type": "text/plain; charset=utf-8" } })
          : new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } });
      }
      return new Response("Not Found", { status: 404 });
    },
  };
}
