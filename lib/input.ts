// What the phone may type into a pane: allowed keys, pasted images, ask-form answers.

import { arr, obj, str, type Obj } from "./json";
import { fieldStops, type AskField, type AskOption } from "./ask-form";
import { IMAGE_MIMES, type AskEntry } from "./transcript";

export const KEYS: Record<string, true> = {
  Enter: true, Escape: true, Tab: true, "shift+Tab": true, Up: true, Down: true, Left: true, Right: true,
  Backspace: true, space: true, "ctrl+c": true, "ctrl+d": true, "ctrl+l": true, "ctrl+p": true,
  // Line editing in an ask form's text inputs: line end, delete to line start / end.
  "ctrl+e": true, "ctrl+u": true, "ctrl+k": true,
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
 * Answers the pending ask form the way omp's terminal form dialog (pi-tui html-form/dialog.ts)
 * reads keys. Its stops are each enabled option row, a group's "Other" input and each text,
 * select or textarea field, then Submit; Tab and Shift+Tab jump between fields, Up/Down between
 * rows, Space picks a radio or toggles a box, Left/Right step a dropdown, Enter on Submit sends.
 *
 * Up first: it ends the dialog's "typing edits your prompt" guard when the desktop draft isn't
 * empty, closes nothing and moves at most one row. Shift+Tab per field then reaches the first
 * field whatever the desktop did, and every move after that is counted from there. A radio or
 * dropdown is set to the phone's pick outright; boxes toggle and text is retyped only where the
 * phone's answer differs from what the field holds: the form's starting values, or what an earlier
 * send typed into this same ask (`applied`), which omp keeps when its own checks refuse the form.
 * A field the body leaves out keeps what it has.
 *
 * `body`: `{ id, values: { name: string | string[] }, other: { name: text } }`, `ask` the newest
 * ask of the session; a string says why the body can't answer it.
 */
export function answerSteps(ask: AskEntry | undefined, body: Obj, applied?: Applied): Step[] | string {
  if (!ask || ask.answer !== null || ask.id !== str(body.id)) return "this question is no longer open";
  if (!body.values || typeof body.values !== "object" || Array.isArray(body.values)) return "no answer given";
  const values = obj(body.values);
  const others = obj(body.other);
  const fields = ask.fields.filter((f) => fieldStops(f) > 0);
  const steps: Step[] = [];
  const keys = (...k: string[]) => {
    const last = steps[steps.length - 1];
    if (last && "keys" in last) last.keys.push(...k);
    else steps.push({ keys: k });
  };
  const type = (text: string) => {
    if (text) steps.push({ text });
  };
  keys("Up", ...Array(fields.length + 1).fill("shift+Tab"));
  for (const [n, f] of fields.entries()) {
    if (n > 0) keys("Tab");
    const name = f.name;
    const was = name && applied && Object.hasOwn(applied.values, name) ? applied.values[name] : undefined;
    const value = name && Object.hasOwn(values, name) ? values[name] : undefined;
    const error = fieldSteps(f, value, name ? str(others[name]).trim() : "", was, name && applied ? str(applied.other[name]).trim() : "", keys, type);
    if (error) return error;
  }
  keys("Tab", "Enter");
  return steps;
}

/** What an earlier send typed into the open ask: its values and Other texts, as the body had them. */
export type Applied = { values: Obj; other: Obj };

/**
 * One field's keys from its first stop; a string names a value it can't take. `was` and `otherWas`:
 * the value and Other text an earlier send left in the field, if any.
 */
function fieldSteps(
  f: AskField,
  value: unknown,
  other: string,
  was: unknown,
  otherWas: string,
  keys: (...k: string[]) => void,
  type: (text: string) => void,
): string | null {
  const name = f.name;
  if (f.kind === "text") {
    if (value === undefined) return null;
    if (typeof value !== "string") return `${name} takes text`;
    const line = (s: string) => (f.multiline ? s : s.replace(/[\r\n]+/g, " "));
    const text = line(value);
    const holds = typeof was === "string" ? line(was) : f.value;
    if (text === holds) return null;
    // To the line's end, then delete back to its start: with lines, each Ctrl+U at a line start joins
    // the line above, and Ctrl+K at a line end joins the one below, so two per line empty the box.
    const lines = f.multiline ? 2 * holds.split("\n").length + 2 : 1;
    keys("ctrl+e", ...Array(lines).fill("ctrl+u"), ...(f.multiline ? Array(lines).fill("ctrl+k") : []));
    type(text);
    return null;
  }
  const enabled = f.options.flatMap((o, i) => (o.disabled ? [] : [i]));
  const rank = (v: string) => enabled.findIndex((i) => f.options[i].value === v);
  const picks = value === undefined ? undefined : f.multi ? arr(value) : [value];
  const bad = picks?.find((v) => typeof v !== "string" || rank(v) === -1);
  if (bad !== undefined) return `${name} has no option ${JSON.stringify(bad)}`;
  if (!f.multi && picks && picks.length !== 1) return `${name} takes one option`;
  if (f.multi && picks && !Array.isArray(value)) return `${name} takes a list`;
  const wanted = picks as string[] | undefined;
  if (f.select && !f.multi) {
    // One stop; Left/Right step through the enabled options and stop at either end, so Left past the
    // first and Right to the pick lands there whatever the desktop chose.
    if (!wanted) return null;
    keys(...Array(enabled.length).fill("Left"), ...Array(rank(wanted[0])).fill("Right"));
    return null;
  }
  let at = 0;
  const moveTo = (row: number) => {
    keys(...Array(row - at).fill("Down"));
    at = row;
  };
  const typeOther = () => {
    moveTo(enabled.length);
    keys("ctrl+e", "ctrl+u");
    type(other.replace(/[\r\n]+/g, " "));
  };
  if (!f.multi) {
    // Other's text answers a radio group in place of its options.
    if (other && f.other) {
      typeOther();
      return null;
    }
    // Space picks a radio, whichever was picked before: the desktop may have changed it.
    if (wanted) {
      moveTo(rank(wanted[0]));
      keys("space");
    }
    return null;
  }
  if (wanted) {
    const held = Array.isArray(was) ? (o: AskOption) => was.includes(o.value) : (o: AskOption) => o.checked;
    for (const [row, i] of enabled.entries()) {
      if (held(f.options[i]) === wanted.includes(f.options[i].value)) continue;
      moveTo(row);
      keys("space");
    }
  }
  // A box group's Other text joins its boxes, so text an earlier send left there is emptied too.
  if (f.other && (other || otherWas)) typeOther();
  return null;
}
