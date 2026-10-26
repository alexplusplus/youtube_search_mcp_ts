# YouTube Search MCP

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js 24](https://img.shields.io/badge/Node.js-24-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP 2026-07-28](https://img.shields.io/badge/MCP-2026--07--28-black?logo=modelcontextprotocol)](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
[![Cloud Run](https://img.shields.io/badge/Google_Cloud_Run-4285F4?logo=googlecloud&logoColor=white)](https://cloud.google.com/run)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare_Workers-F38020?logo=cloudflareworkers&logoColor=white)](https://workers.cloudflare.com/)

A small [MCP](https://modelcontextprotocol.io) server that shows how you can **customise YouTube search** for an AI assistant. Instead of passing YouTube's results straight through, it applies its own rule on top of the YouTube Data API.

This implementation **demonstrates** an algorithm that returns videos that are *both* relevant *and* popular. You can swap in your own logic, such as other filters, other ranking, or combination of several searches.

This server works with MCP clients that support remote servers over [Streamable HTTP](https://modelcontextprotocol.io/docs/transports/streamable-http). It's built on the MCP TypeScript SDK v2, so it speaks the [2026-07-28 protocol](https://blog.modelcontextprotocol.io/posts/2026-07-28/) natively and still serves clients on 2025 versions. The same code deploys to **Google Cloud Run** and to **Cloudflare Workers**, so it's reachable from anywhere.

## Core search algorithm

When AI assistant needs to search videos it calls the `search_youtube` tool with `search_query`. The server:

1. Runs two parallel YouTube searches for the `search_query`: one sorted by **relevance** and one sorted by **view count**.
2. Keeps only the videos that appear in **both** results (overlap). If fewer than 5 match, it also checks the second page of each search.
3. Looks up the details of those videos and returns them in relevance order.

Video attributes in the returned list are: title, channel name, view count, publication date, length, full description and a URL. The tool returns the videos as JSON text (without structured schema declaration), which is what the MCP client reads.

To modify the search algorithm, start from `search()` function in `src/tools.ts` and then follow the code down to `youtube.ts`.

Additional tool `get_video_data` returns the same details for videos you already know, given as ids or YouTube URLs.

## High-level overview of the codebase

- **`src/node.ts`** and **`src/worker.ts`** are the two entry points, one per runtime environment: Node.js and Cloudflare Workers. Each reads the API key from its environment, creates the app by calling `createApp(apiKey)` and hands it incoming requests. `node.ts` serves it on a port for local runs and Cloud Run. `worker.ts` is the Cloudflare Worker: it creates the app on the first request and reuses it afterwards. Nothing else in them and the rest of the codebase is runtime-specific.
- **`src/server.ts`** holds `createApp()`, which returns a web-standard `fetch(Request) → Response` handler. It answers `/health` itself and passes `/mcp` to the MCP server, which registers the two tools, `search_youtube` and `get_video_data`. This file connects the MCP server to the tool functions defined in `tools.ts`, converting their results into the JSON text that the MCP client expects.
- **`src/tools.ts`** contains what the tools actually do. `search()` runs the [core search algorithm](#core-search-algorithm) and `videoData()` looks up specific videos. Both write one log line per call.
- They rely on two modules:
  - **`src/overlap.ts`** decides which videos match
  - **`src/youtube.ts`** is the YouTube API client. It handles everything about talking to YouTube: building requests, timeouts, retries, error handling, and parsing the API responses.

Everything below the entry points is shared by both runtimes, which is why the same code deploys to Cloud Run and to Workers.

## Prerequisites

- [Node.js 24](https://nodejs.org/) or later
- A **YouTube Data API key**. In the [Google Cloud Console](https://console.cloud.google.com/), enable the *YouTube Data API v3* and create an API key under *APIs & Services → Credentials*.

## Deployment options

### Local

1. Create a file named `.env` in the project folder containing your key (see `.env.example`):

   ```
   YOUTUBE_API_KEY=your-key-here
   ```

2. Start the server:

   ```
   npm start
   ```

Server URL: `http://localhost:8000/mcp`.

### Google Cloud Run

Prerequisites: [gcloud CLI](https://cloud.google.com/sdk/docs/install), logged in to a Google Cloud project with billing enabled.

Run the following from the project folder:

```
gcloud run deploy youtube-search-mcp --source . \
  --project <your-project> --region us-central1 \
  --no-invoker-iam-check \
  --min-instances 0 --max-instances 1 \
  --set-env-vars YOUTUBE_API_KEY=<your-key>
```

When it finishes, it prints your service URL. Check that the server is running with `curl https://<your-service-url>/health`. It should print `ok`.

The Server URL is `https://<your-service-url>/mcp`.

### Cloudflare Workers

Prerequisites: a [Cloudflare account](https://dash.cloudflare.com/sign-up). The free plan is enough.
Run the following from the project folder (one by one):

```
npx wrangler login
npx wrangler secret put YOUTUBE_API_KEY
npm run deploy:worker
```

`secret put` asks for the key and stores it encrypted. The first deploy creates the Worker, and the next deploys update it. The command prints your URL, `https://youtube-search-mcp.<your-subdomain>.workers.dev`. Check it with `curl https://<your-worker-url>/health`.

The Server URL is `https://<your-worker-url>/mcp`.

To try the Worker locally first, put `YOUTUBE_API_KEY=your-key-here` in a file named `.dev.vars` and run `npm run dev:worker`. The server is then at `http://localhost:8787/mcp`.

## Connecting a Client to a cloud-hosted server

### Claude Code

```
claude mcp add --transport http --scope user youtube-search <your-server-url>
```

Then ask something like *"Search YouTube for python asyncio tutorials"*.

### Claude Desktop

Go to *Customize → Connectors → Add custom connector*, paste your server URL and choose *No sign-in*.

## Additional Notes

- **Limited searches.** YouTube API allows about 100 searches per day per key, which is roughly 25–50 uses of this tool. The limit resets at midnight Pacific time.
- **No login.** Anyone who knows your server's URL can use it and spend your daily searches. On Cloud Run, `--max-instances 1` and the daily limit stop it from costing you money. On Workers, the free plan simply stops serving requests past its daily limit. Either way, keep the URL private.
- **Your key is visible** in the Cloud Run settings to anyone who has access to your Google Cloud project. On Workers it is a secret: nobody can read it back, not even you.
- **Older clients get streamed replies.** Clients on the current MCP protocol (2026-07-28) get plain JSON replies. Clients still on a 2025 version are served too, but each reply comes back as a short Server-Sent Events stream. Every compliant client handles both.

## Tests

See [tests/README.md](tests/README.md).

## License

[MIT](LICENSE)
