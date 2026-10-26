/** Node entrypoint (local and Cloud Run): `node src/node.ts`, listening on $PORT. */

import { serve } from "@hono/node-server";
import { createApp } from "./server.ts";

const app = createApp(process.env.YOUTUBE_API_KEY ?? "");
const port = Number(process.env.PORT ?? 8000);

const server = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
  console.log(JSON.stringify({ severity: "INFO", message: `listening on port ${info.port}` }));
});

// Cloud Run sends SIGTERM before stopping an instance: finish in-flight requests, then exit.
process.on("SIGTERM", () => server.close(() => process.exit(0)));
