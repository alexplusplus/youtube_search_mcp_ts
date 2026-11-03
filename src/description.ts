/**
 * Description cleaning: drop channel boilerplate (sponsors, links, socials, bios) from a video
 * description, keeping what is about the video and always keeping its chapter lines.
 *
 * One Clairic call per video asks for two anchors, the first and the last sentence about this
 * video; the whole original lines between them are kept. Chapter lines are taken out of the
 * input (they capture the anchors otherwise) and added back by rule. Any failure returns the
 * original description: cleaning never fails a tool call. Evaluation: docs/clairic-eval/round2.
 *
 * The only I/O is the injected Extractor, so everything here runs offline in tests.
 */

import type { Video } from "./youtube.ts";

// --- Chapter lines -------------------------------------------------------------------------------

const TIMESTAMP = /^\s*[([]?\d{1,2}:\d{2}(?::\d{2})?[)\]]?\s*[-–—:|]?\s*\S/;
const BLANK = /^[\s\-_=—–.]*$/;

/** Indices of timestamp lines, plus the short heading right above the first ones ("Chapters"). */
function chapterLines(lines: string[]): Set<number> {
  const chapters = new Set<number>();
  lines.forEach((line, i) => {
    if (!TIMESTAMP.test(line)) return;
    chapters.add(i);
    let j = i - 1;
    while (j >= 0 && BLANK.test(lines[j])) j--;
    const heading = lines[j];
    if (
      heading !== undefined &&
      !TIMESTAMP.test(heading) &&
      heading.trim().length <= 30 &&
      !/https?:|www\./.test(heading)
    ) {
      chapters.add(j);
    }
  });
  return chapters;
}

// --- Clairic request -----------------------------------------------------------------------------

export const CLAIRIC_MODEL = "@cf/cloudflare/clairic";

const BOILERPLATE =
  "Boilerplate is text the channel repeats under every video and that says nothing about this video: " +
  "sponsor and affiliate links, discount codes, the creator's other courses, products or videos, " +
  "newsletters, memberships, Patreon or donation requests, merch, social media and community links " +
  "(Discord, Instagram, X), 'like and subscribe' requests, channel or creator bios, disclaimers, " +
  "hashtags and keyword lists.";
const CONTENT =
  "The part of the description that tells what THIS video (see the title) is about: its topic, what it " +
  "covers, who appears in it, and resources that belong to this video only, such as its dataset, code, " +
  `paper, syllabus or assignments. ${BOILERPLATE}`;

export type Fields = Record<string, { type: "text"; instructions: string }>;

const FIELDS: Fields = {
  content_first: {
    type: "text",
    instructions: `The first sentence or line of the description that is about THIS video, skipping any boilerplate before it. ${CONTENT}`,
  },
  content_last: {
    type: "text",
    instructions: `The last sentence or line of the description that is about THIS video, before any trailing boilerplate. ${CONTENT}`,
  },
};

/** One Clairic answer. `span` is [start, end) in Unicode code points of `state`, not UTF-16 units. */
export interface Answer {
  value?: unknown;
  span?: [number, number] | null;
  confidence?: number;
}
export type Answers = Record<string, Answer | undefined>;

/** Runs one Clairic extraction. The Worker wraps its AI binding; tests pass a fake. */
export interface Extractor {
  extract(state: string, fields: Fields, signal: AbortSignal): Promise<Answers>;
}

type Source = Pick<Video, "title" | "channel"> & { description: string };

export interface Prepared {
  state: string;
  /** Length of the title header in code points: spans before it are not in the description. */
  offset: number;
  /** map[k] = original line index of line k of the reduced description (chapters removed). */
  map: number[];
  fields: Fields;
}

export function prepareClean(video: Source): Prepared {
  const lines = video.description.split("\n");
  const chapters = chapterLines(lines);
  const map = lines.flatMap((_, i) => (chapters.has(i) ? [] : [i]));
  const header = `Video title: ${video.title ?? ""}\nChannel: ${video.channel ?? ""}\n\nVideo description:\n`;
  return {
    state: header + map.map((i) => lines[i]).join("\n"),
    offset: Array.from(header).length,
    map,
    fields: FIELDS,
  };
}

/** The cleaned description, or null when no usable anchor came back (the caller fails open). */
export function applyAnchors(
  description: string,
  answers: Answers,
  prepared: Prepared,
): string | null {
  const { offset, map } = prepared;
  // A span inside the title header is not in the description: treat it as not found.
  const at = (answer: Answer | undefined, end: boolean): number | null =>
    answer?.value != null && answer.span && answer.span[1] > offset
      ? Math.max(0, answer.span[end ? 1 : 0] - offset)
      : null;
  const start = at(answers.content_first, false);
  const end = at(answers.content_last, true);
  if ((start === null && end === null) || map.length === 0) return null;

  // Line k of the reduced description ends at code point lineEnds[k].
  const reduced = Array.from(prepared.state).slice(offset).join("").split("\n");
  const lineEnds: number[] = [];
  let pos = 0;
  for (const line of reduced) {
    pos += Array.from(line).length;
    lineEnds.push(pos);
    pos += 1; // the newline
  }
  const lineAt = (p: number) => {
    const k = lineEnds.findIndex((lineEnd) => p <= lineEnd);
    return k === -1 ? reduced.length - 1 : k;
  };
  const a = map[lineAt(start ?? 0)];
  const b = map[end === null ? reduced.length - 1 : lineAt(end)];
  const [from, to] = [Math.min(a, b), Math.max(a, b)];

  const lines = description.split("\n");
  const chapters = chapterLines(lines);
  return lines
    .filter((_, i) => (i >= from && i <= to) || chapters.has(i))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const CLEAN_TIMEOUT_MS = 3000;

/** The video's description without boilerplate; the original on any failure. Never throws. */
export async function cleanDescription(
  video: Pick<Video, "id" | "title" | "channel" | "description">,
  extractor: Extractor,
  timeoutMs = CLEAN_TIMEOUT_MS,
): Promise<string | null> {
  const { description } = video;
  if (!description?.trim()) return description;
  const prepared = prepareClean({ ...video, description });
  if (prepared.map.length === 0) return description; // nothing but chapters

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    const answers = await Promise.race([
      extractor.extract(prepared.state, prepared.fields, controller.signal),
      timeout,
    ]);
    return applyAnchors(description, answers, prepared) ?? description;
  } catch (error) {
    console.log(
      JSON.stringify({
        severity: "WARNING",
        message: "description cleaning failed; returning the original",
        video: video.id,
        error: String(error),
      }),
    );
    return description;
  } finally {
    clearTimeout(timer);
  }
}
