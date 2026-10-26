import { configDefaults, defineConfig } from "vitest/config";

const LIVE = "tests/live.test.ts";

// `vitest run --mode live` runs only the live test, which spends real search quota;
// every other run excludes it.
export default defineConfig(({ mode }) => {
  if (mode === "live") {
    try {
      process.loadEnvFile(".env");
    } catch {
      // No .env: the key may come from the environment itself.
    }
  }
  return {
    test:
      mode === "live"
        ? { include: [LIVE] }
        : { include: ["tests/**/*.test.ts"], exclude: [...configDefaults.exclude, LIVE] },
  };
});
