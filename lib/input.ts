// What the phone may type into a pane: allowed keys, pasted images, ask-dialog answers.

import { arr, num, obj, str, type Obj } from "./json";
import { IMAGE_MIMES, type AskEntry } from "./transcript";

export const KEYS: Record<string, true> = {
  Enter: true, Escape: true, Tab: true, "shift+Tab": true, Up: true, Down: true, Left: true, Right: true,
  Backspace: true, space: true, "ctrl+c": true, "ctrl+d": true, "ctrl+l": true, "ctrl+p": true,
  PageUp: true, PageDown: true, "1": true, "2": true, "3": true, "4": true, "5": true, y: true, n: true,
};

export type PromptImage = { data: string; mimeType: string };
export const MAX_PROMPT_IMAGES = 8;
/** Base64 characters across a prompt's images (~15 MB decoded). */
export const MAX_IMAGE_CHARS = 20 * 1024 * 1024;

/** The pasted images of a submit body; a string when one doesn't qualify. */
export function promptImages(raw: unknown): PromptImage[] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_PROMPT_IMAGES) return `at most ${MAX_PROMPT_IMAGES} images`;
  const images = raw.map((r) => ({ data: str(obj(r).data), mimeType: str(obj(r).mimeType) }));
  if (images.some((i) => IMAGE_MIMES[i.mimeType] !== true || !/^[A-Za-z0-9+/]+=*$/.test(i.data))) return "unsupported image";
  if (images.reduce((n, i) => n + i.data.length, 0) > MAX_IMAGE_CHARS) return "images too large";
  return images;
}

/** Keys for `tern send … keys`, or text typed into a prompt that the previous keys opened. */
export type Step = { keys: string[] } | { text: string };

/**
 * Answers the pending ask dialog the way its keyboard works (pi-tui ask-dialog): each question
 * opens on its recommended row; Enter picks a single option and moves on, Space toggles a multi
 * option and Enter moves on; "Other…" follows the options and opens a prompt for typed text.
 * Dialogs with several questions end on a Review tab that Enter submits.
 * `ask` is the newest ask of the session; a string says why the body can't answer it.
 */
export function answerSteps(ask: AskEntry | undefined, body: Obj): Step[] | string {
  if (!ask || ask.answer !== null || ask.id !== str(body.id)) return "this question is no longer open";
  const answers = arr(body.answers).map(obj);
  if (answers.length !== ask.questions.length) return "answer every question";
  const invalid = ask.questions.findIndex((q, i) => {
    const a = answers[i];
    if (str(a.other).trim()) return false;
    if (q.multi) return !Array.isArray(a.picks);
    return typeof a.option !== "number" || a.option < 0 || a.option >= q.options.length;
  });
  if (invalid >= 0) return `question ${invalid + 1} has no valid answer`;

  const steps: Step[] = [];
  ask.questions.forEach((q, i) => {
    const a = answers[i];
    const otherRow = q.options.length;
    // The desktop may have moved the cursor; Up clamps at the first row, so enough of them
    // put it on row 0 whatever its position, and navigation is absolute from there.
    const reset: string[] = Array(otherRow).fill("Up");
    let at = 0;
    const moveTo = (row: number) => {
      const keys: string[] = [...reset.splice(0)];
      for (; at < row; at++) keys.push("Down");
      for (; at > row; at--) keys.push("Up");
      return keys;
    };
    const other = str(a.other).trim();
    if (q.multi) {
      const picks = arr(a.picks).filter((n): n is number => typeof n === "number" && n >= 0 && n < otherRow);
      const keys = [...new Set(picks)].sort((x, y) => x - y).flatMap((p) => [...moveTo(p), "space"]);
      if (other) {
        steps.push({ keys: [...keys, ...moveTo(otherRow), "Enter"] }, { text: other }, { keys: ["Enter"] });
        // A lone multi question jumps to Review after a typed answer; Enter there submits.
        if (ask.questions.length === 1) steps.push({ keys: ["Enter"] });
      } else steps.push({ keys: [...keys, ...reset.splice(0), "Enter"] });
    } else if (other) {
      steps.push({ keys: [...moveTo(otherRow), "Enter"] }, { text: other }, { keys: ["Enter"] });
    } else {
      steps.push({ keys: [...moveTo(num(a.option)), "Enter"] });
    }
  });
  if (ask.questions.length > 1) steps.push({ keys: ["Enter"] });
  return steps;
}
