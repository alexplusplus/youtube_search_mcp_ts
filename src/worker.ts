/** Cloudflare Workers entrypoint: the same app, with the key read from the Worker's secret. */

import { type App, createApp } from "./server.ts";

interface Env {
  YOUTUBE_API_KEY?: string;
}

// Built on the first request an isolate serves, then reused; rebuilt if the secret changes.
let cached: { key: string; app: App } | undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const key = env.YOUTUBE_API_KEY ?? "";
    if (cached?.key !== key) cached = { key, app: createApp(key) };
    return cached.app.fetch(request);
  },
};
