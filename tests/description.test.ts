import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  type Answers,
  applyAnchors,
  cleanDescription,
  type Extractor,
  prepareClean,
} from "../src/description.ts";

/** Saved Clairic answers from the T0 eval run (docs/clairic-eval/round2/results/T0.json). */
interface Case {
  id: string;
  title: string;
  channel: string;
  description: string;
  state: string;
  fields: unknown;
  answers: Answers;
  output: string;
}
const CASES: Case[] = JSON.parse(
  readFileSync(new URL("./fixtures/clairic_t0.json", import.meta.url), "utf8"),
);
const byId = (id: string) => CASES.find((c) => c.id === id) as Case;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  return () => vi.restoreAllMocks();
});

const answered = (answers: Answers): Extractor => ({ extract: async () => answers });

describe("recorded eval answers", () => {
  test.each(CASES.map((c) => [c.id, c] as const))(
    "%s: same request and output as the eval",
    async (_, c) => {
      const prepared = prepareClean(c);
      expect(prepared.state).toBe(c.state);
      expect(prepared.fields).toEqual(c.fields);

      expect(await cleanDescription(c, answered(c.answers))).toBe(c.output);
    },
  );

  test("chapters are removed from the input and added back to the output", () => {
    const c = byId("nTWe3P7hjxs");
    const chapterLine = c.description.split("\n").find((l) => /^\s*\d{1,2}:\d{2}/.test(l));

    expect(chapterLine).toBeDefined();
    expect(prepareClean(c).state).not.toContain(chapterLine);
    expect(c.output).toContain(chapterLine);
  });

  test("spans count code points, so emoji before them don't shift the kept lines", () => {
    const c = byId("zbCxi7CjiF0");

    expect(Array.from(c.state).length).toBeLessThan(c.state.length); // has astral characters
    expect(applyAnchors(c.description, c.answers, prepareClean(c))).toBe(c.output);
  });

  test("both anchors on one sentence keep only that paragraph plus chapters (known limit)", () => {
    const c = byId("0-QDPnEIkvw");

    expect(c.output).toContain("Build a knowledge base");
    expect(c.output).not.toContain("Resources:");
  });
});

describe("anchors", () => {
  const video = {
    id: "v",
    title: "How to bake bread",
    channel: "Baker",
    description:
      "Buy my course: https://x.y\n\nWe bake a sourdough loaf.\nFlour, water, salt.\n\nFollow me on X",
  };
  const prepared = prepareClean(video);
  const span = (text: string): [number, number] => {
    const start = Array.from(prepared.state.slice(0, prepared.state.indexOf(text))).length;
    return [start, start + Array.from(text).length];
  };

  test("whole lines between the anchors are kept", () => {
    const answers = {
      content_first: { value: "We bake", span: span("We bake") },
      content_last: { value: "salt.", span: span("salt.") },
    };

    expect(applyAnchors(video.description, answers, prepared)).toBe(
      "We bake a sourdough loaf.\nFlour, water, salt.",
    );
  });

  test("an anchor in the title header counts as not found", () => {
    const answers = {
      content_first: { value: "How to bake bread", span: span("How to bake bread") },
      content_last: { value: "salt.", span: span("salt.") },
    };

    expect(applyAnchors(video.description, answers, prepared)).toBe(
      "Buy my course: https://x.y\n\nWe bake a sourdough loaf.\nFlour, water, salt.",
    );
  });

  test("only a first anchor runs to the end", () => {
    const answers = { content_first: { value: "We bake", span: span("We bake") } };

    expect(applyAnchors(video.description, answers, prepared)).toBe(
      "We bake a sourdough loaf.\nFlour, water, salt.\n\nFollow me on X",
    );
  });

  test("no anchors is null", () => {
    const answers = { content_first: { value: null }, content_last: { value: null } };

    expect(applyAnchors(video.description, answers, prepared)).toBeNull();
  });

  test("no anchors fails open to the original description", async () => {
    expect(await cleanDescription(video, answered({}))).toBe(video.description);
  });
});

describe("failures return the original description", () => {
  const c = CASES[0];

  test("extractor throws", async () => {
    const extractor: Extractor = {
      extract: async () => {
        throw new Error("AI down");
      },
    };

    expect(await cleanDescription(c, extractor)).toBe(c.description);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("AI down"));
  });

  test("malformed response", async () => {
    const extractor = { extract: async () => undefined } as unknown as Extractor;

    expect(await cleanDescription(c, extractor)).toBe(c.description);
  });

  test("timeout aborts the call", async () => {
    let signal: AbortSignal | undefined;
    const extractor: Extractor = {
      extract: (_state, _fields, s) => {
        signal = s;
        return new Promise(() => {});
      },
    };

    expect(await cleanDescription(c, extractor, 10)).toBe(c.description);
    expect(signal?.aborted).toBe(true);
  });

  test.each([null, "", "  "])("empty description %j makes no call", async (description) => {
    const extract = vi.fn();

    expect(await cleanDescription({ ...c, description }, { extract })).toBe(description);
    expect(extract).not.toHaveBeenCalled();
  });

  test("a description of only chapters makes no call", async () => {
    const extract = vi.fn();
    const description = "Chapters\n0:00 Intro\n1:23 Main part";

    expect(await cleanDescription({ ...c, description }, { extract })).toBe(description);
    expect(extract).not.toHaveBeenCalled();
  });
});
