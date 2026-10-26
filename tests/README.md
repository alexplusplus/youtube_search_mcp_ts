# Tests

Run them from the project folder:

```
npm test
```

These tests don't call YouTube; they use saved responses from `fixtures/recorded_responses.json`. They are free to run as often as you like. `tests/server.test.ts` drives the whole server through a real MCP client, still offline.

## Live test

One extra test calls the real YouTube API through the server, the same way a client would. Each run uses 2–4 of your 100 daily searches, so it only runs when you ask for it:

```
npm run test:live
```

It needs your key in `.env` (see the main [README](../README.md)).
