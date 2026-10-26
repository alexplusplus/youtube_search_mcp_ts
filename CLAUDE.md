# CLAUDE.md

A remote MCP server with two tools, deployable to both Cloud Run and Cloudflare Workers. `search_youtube` returns the **overlap** of YouTube's relevance-ordered and view-count-ordered searches, enriched with video details. `get_video_data` returns the same details for videos given by id or URL (`videos.list` only, no search quota). Use the domain terms exactly as `GLOSSARY.md` defines them. This is a TypeScript port of `../youtube_search_mcp` (Python) and keeps its behaviour and messages.

## Gate before calling work done

`npm run check` runs `biome check`, `tsc` and `vitest run`, and all three must be clean. When you touch `src/worker.ts`, `src/server.ts` or dependencies, also run `npx wrangler deploy --dry-run` to prove the Worker still bundles.

## Quota is the scarce resource

- `search.list` has its own bucket of **100 calls/day**, and one tool run costs 2–4 of them. Develop against the offline suite: an injected fake `fetch` (`tests/fake-youtube.ts`) plus the recorded pages in `tests/fixtures/recorded_responses.json`.
- The live test spends real quota, so run it only when the user asks: `npm run test:live`.
- To learn an error's shape, read Google's docs or use a deliberately invalid key, which costs no quota.

## The API key

- It lives only in `.env` / `.dev.vars` (`YOUTUBE_API_KEY`), in the Cloud Run env var and in the Worker secret. Reference it by name; its value never enters a file, a log line or a command you write.
- It travels in the `X-Goog-Api-Key` header so it never appears in a URL or error.

## Two runtimes, one app

- All logic sits behind `createApp(apiKey) → { fetch(Request): Promise<Response> }` in `server.ts`. Use only web-standard APIs there and below: `fetch`, `URL`, `AbortController`, `setTimeout`, no `node:*` imports. `node.ts` and `worker.ts` stay thin mounts.
- Node runs `src/*.ts` directly (type stripping), so there's no build step. Relative imports end in `.ts`, and `erasableSyntaxOnly` forbids enums, namespaces and constructor parameter properties.
- Never store the global `fetch` as an object property and call it as a method: workerd throws "Illegal invocation". Wrap it, as `YouTubeClient` does.
- A Worker has no startup phase, so `worker.ts` builds the app on the first request and caches it per isolate.

## SDK traps (MCP TypeScript SDK v2)

Most examples online are v1 (`@modelcontextprotocol/sdk`). In this repo:
- The packages are `@modelcontextprotocol/server` (and `/client` for tests). Tools use `registerTool(name, { inputSchema: z.object(...) }, cb)` with zod v4.
- `createMcpHandler` serves the 2026-07-28 protocol in plain JSON and 2025-era clients through its built-in stateless fallback, which always answers with SSE. That differs from the Python server (JSON for everyone) and is accepted to keep `server.ts` free of custom transport code.
- The SDK sends **any** thrown error's message to the client. Only a `ToolError`'s message is meant for the client. `respond()` in `server.ts` turns anything else into a bare `Error executing tool <name>`.

## Design rules

- `overlap.ts` stays pure, with no I/O. `youtube.ts` owns everything about the wire: params, retry, timeouts, error classification and parsing. `tools.ts` holds the `search()` and `videoData()` tool bodies, which tests call directly without the MCP layer. `server.ts` is glue.
- Tools return one text block holding the videos as JSON, with no `outputSchema` or `structuredContent`. The Python server had both (inferred from its return type); they were dropped on purpose because the model reads the text either way, and `tests/server.test.ts` asserts their absence.
- **Error classification reads both reasons:** `error.errors[0].reason` and the ErrorInfo `error.details[].reason`. Real invalid-key responses carry the generic `badRequest` beside `API_KEY_INVALID` (see `invalid key is a key problem despite generic errors reason`).
- Retryable means exactly "classifies as unavailable": one retry, never on quota.
- Durations in code are milliseconds (`retryDelay`, `requestTimeout`, Retry-After cap). The timeout covers the whole attempt, including reading the body.
