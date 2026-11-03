/**
 * Cloudflare Workers entrypoint: the same app, with the key read from the Worker's secret and
 * description cleaning through the Workers AI binding.
 */

import { type Answers, CLAIRIC_MODEL, type Extractor } from "./description.ts";
import { type App, createApp } from "./server.ts";

interface Ai {
  run(model: string, input: unknown): Promise<unknown>;
}

interface Env {
  YOUTUBE_API_KEY?: string;
  AI?: Ai;
}

/** Calls through the binding each time: a stored `ai.run` throws "Illegal invocation" in workerd. */
function clairic(ai: Ai): Extractor {
  return {
    async extract(state, fields) {
      const result = (await ai.run(CLAIRIC_MODEL, { model: "clairic", state, fields })) as {
        answers: Answers;
      };
      return result.answers;
    },
  };
}

// Built on the first request an isolate serves, then reused; rebuilt if the secret changes.
let cached: { key: string; app: App } | undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const key = env.YOUTUBE_API_KEY ?? "";
    if (cached?.key !== key) {
      cached = { key, app: createApp(key, { extractor: env.AI ? clairic(env.AI) : undefined }) };
    }
    return cached.app.fetch(request);
  },
};
