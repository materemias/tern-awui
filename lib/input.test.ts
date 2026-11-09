import { describe, expect, test } from "bun:test";
import { answerSteps, KEYS, MAX_IMAGE_CHARS, MAX_PROMPT_IMAGES, promptImages, type Step } from "./input";
import { parseAskForm } from "./ask-form";
import type { AskEntry } from "./transcript";

describe("promptImages", () => {
  const png = { data: "iVBORw0KGgo=", mimeType: "image/png" };

  test("no images is an empty list", () => expect(promptImages(undefined)).toEqual([]));

  test("keeps only data and mimeType", () => {
    expect(promptImages([{ ...png, name: "x.png", extra: 1 }])).toEqual([png]);
  });

  test("accepts up to the limit, refuses more or a non-list", () => {
    expect(promptImages(Array(MAX_PROMPT_IMAGES).fill(png))).toHaveLength(MAX_PROMPT_IMAGES);
    expect(promptImages(Array(MAX_PROMPT_IMAGES + 1).fill(png))).toBe(`at most ${MAX_PROMPT_IMAGES} images`);
    expect(promptImages(png)).toBe(`at most ${MAX_PROMPT_IMAGES} images`);
    expect(promptImages(null)).toBe(`at most ${MAX_PROMPT_IMAGES} images`);
  });

  test("refuses other types, data URLs and non-base64 data", () => {
    expect(promptImages([{ data: png.data, mimeType: "image/svg+xml" }])).toBe("unsupported image");
    expect(promptImages([{ data: `data:image/png;base64,${png.data}`, mimeType: "image/png" }])).toBe("unsupported image");
    expect(promptImages([{ data: "", mimeType: "image/png" }])).toBe("unsupported image");
    expect(promptImages([png, "junk"])).toBe("unsupported image");
  });

  test("caps the total size across images", () => {
    const half = { data: "A".repeat(MAX_IMAGE_CHARS / 2), mimeType: "image/jpeg" };
    expect(promptImages([half, half])).toHaveLength(2);
    expect(promptImages([half, half, { data: "AAAA", mimeType: "image/gif" }])).toBe("images too large");
  });
});

describe("answerSteps", () => {
  const ask = (html: string): AskEntry => ({ role: "ask", id: "ask1", html, fields: parseAskForm(html), question: "", answer: null, ts: 0 });
  const steps = (a: AskEntry, values: Record<string, unknown>, other: Record<string, string> = {}) => answerSteps(a, { id: "ask1", values, other });
  const n = (key: string, times: number) => Array(times).fill(key);
  const radios = ask(`<fieldset><legend>Store</legend>
    <label><input type="radio" name="store" value="sqlite" checked> SQLite</label>
    <label><input type="radio" name="store" value="redis"> Redis</label>
    <label><input type="radio" name="store" value="pg"> Postgres</label></fieldset>`);
  // The reset every answer starts with: Up ends the draft guard, Shift+Tab per field (plus one) reaches the first.
  const top = (fields: number) => ["Up", ...n("shift+Tab", fields + 1)];

  test("refuses a missing, answered or different ask, and a body with no values", () => {
    expect(answerSteps(undefined, { id: "ask1", values: {} })).toBe("this question is no longer open");
    expect(answerSteps({ ...radios, answer: "done" }, { id: "ask1", values: {} })).toBe("this question is no longer open");
    expect(answerSteps(radios, { id: "other", values: {} })).toBe("this question is no longer open");
    // Without values it would submit the model's own picks as if the phone had chosen them.
    expect(answerSteps(radios, { id: "ask1" })).toBe("no answer given");
    expect(answerSteps(ask(`<label><input type="checkbox" name="x" value="a"> A</label>`), { id: "ask1", values: { x: "a" } })).toBe("x takes a list");
  });

  test("a radio: Down to its row, Space, then Tab to Submit and Enter, the preselected one too", () => {
    expect(steps(radios, { store: "pg" })).toEqual([{ keys: [...top(1), ...n("Down", 2), "space", "Tab", "Enter"] }]);
    // The desktop may have picked another one meanwhile: Space sets the phone's pick regardless.
    expect(steps(radios, { store: "sqlite" })).toEqual([{ keys: [...top(1), "space", "Tab", "Enter"] }]);
  });

  test("Other's text answers a radio group: past the options to its input, emptied, typed", () => {
    expect(steps(radios, { store: "redis" }, { store: "  MySQL  " })).toEqual([
      { keys: [...top(1), ...n("Down", 3), "ctrl+e", "ctrl+u"] },
      { text: "MySQL" },
      { keys: ["Tab", "Enter"] },
    ]);
  });

  test("checkboxes toggle only what differs from the form's own checks; Other's text adds to them", () => {
    const boxes = ask(`<label><input type="checkbox" name="x" value="a" checked> A</label>
      <label><input type="checkbox" name="x" value="b" disabled> B</label>
      <label><input type="checkbox" name="x" value="c"> C</label>`);
    // Disabled rows aren't stops: C is the second row.
    expect(steps(boxes, { x: ["c"] })).toEqual([{ keys: [...top(1), "space", "Down", "space", "Tab", "Enter"] }]);
    expect(steps(boxes, { x: ["a"] }, { x: "D" })).toEqual([{ keys: [...top(1), ...n("Down", 2), "ctrl+e", "ctrl+u"] }, { text: "D" }, { keys: ["Tab", "Enter"] }]);
  });

  test("a resend counts from what the last send typed, which omp keeps after refusing the form", () => {
    const form = ask(`<label><input type="checkbox" name="x" value="a" checked> A</label><label><input type="checkbox" name="x" value="b"> B</label>
      <textarea name="t">one</textarea>`);
    // The last send ticked B, typed Other "Z" and three lines; the resend drops Z and keeps A and B.
    const applied = { values: { x: ["a", "b"], t: "1\n2\n3" }, other: { x: "Z" } };
    expect(answerSteps(form, { id: "ask1", values: { x: ["a", "b"], t: "new" }, other: {} }, applied)).toEqual([
      { keys: [...top(2), ...n("Down", 2), "ctrl+e", "ctrl+u", "Tab", "ctrl+e", ...n("ctrl+u", 8), ...n("ctrl+k", 8)] },
      { text: "new" },
      { keys: ["Tab", "Enter"] },
    ]);
    // Boxes and text as the last send left them need no keys; Other's text is typed whole every time.
    expect(answerSteps(form, { id: "ask1", values: { x: ["a", "b"], t: "1\n2\n3" }, other: { x: "Z" } }, applied)).toEqual([
      { keys: [...top(2), ...n("Down", 2), "ctrl+e", "ctrl+u"] },
      { text: "Z" },
      { keys: ["Tab", "Tab", "Enter"] },
    ]);
  });

  test("a dropdown steps Left to its first enabled option, then Right to the pick", () => {
    const select = ask(`<select name="db"><option>pg<option selected>sqlite<option disabled>oracle<option>mysql</select>`);
    expect(steps(select, { db: "mysql" })).toEqual([{ keys: [...top(1), ...n("Left", 3), ...n("Right", 2), "Tab", "Enter"] }]);
    expect(steps(select, { db: "sqlite" })).toEqual([{ keys: [...top(1), ...n("Left", 3), "Right", "Tab", "Enter"] }]);
    expect(steps(select, { db: "oracle" })).toBe('db has no option "oracle"');
  });

  test("text replaces the starting value; a textarea is emptied line by line", () => {
    const form = ask(`<label>Days <input type="number" name="days" value="30"></label>
      <textarea name="notes">one
two</textarea>`);
    expect(steps(form, { days: "7\n", notes: "a\nb" })).toEqual([
      { keys: [...top(2), "ctrl+e", "ctrl+u"] },
      { text: "7 " },
      { keys: ["Tab", "ctrl+e", ...n("ctrl+u", 6), ...n("ctrl+k", 6)] },
      { text: "a\nb" },
      { keys: ["Tab", "Enter"] },
    ]);
    // Unchanged text, or a field left out, is left alone; emptying needs no typing.
    expect(steps(form, { days: "30" })).toEqual([{ keys: [...top(2), "Tab", "Tab", "Enter"] }]);
    expect(steps(form, { days: "" })).toEqual([{ keys: [...top(2), "ctrl+e", "ctrl+u", "Tab", "Tab", "Enter"] }]);
  });

  test("fields walk in document order; hidden inputs, buttons and option-less dropdowns aren't stops", () => {
    const form = ask(`<input type="hidden" name="h" value="1"><input type="submit"><select name="none"><option disabled>x</select>
      <label>Name <input name="who"></label>${radios.html}`);
    expect(steps(form, { who: "Ann", store: "redis" })).toEqual([
      { keys: [...top(2), "ctrl+e", "ctrl+u"] },
      { text: "Ann" },
      { keys: ["Tab", "Down", "space", "Tab", "Enter"] },
    ]);
  });

  test("names values the form can't take", () => {
    expect(steps(radios, { store: ["redis"] })).toBe('store has no option ["redis"]');
    expect(steps(radios, { store: "nope" })).toBe('store has no option "nope"');
    expect(steps(ask(`<input name="t">`), { t: 3 })).toBe("t takes text");
  });

  test("every key it produces is one /keys accepts", () => {
    const form = ask(`${radios.html}<label><input type="checkbox" name="x" value="a"> A</label><label><input type="checkbox" name="x" value="b"> B</label>
      <select name="s"><option>a<option>b</select><textarea name="t">x</textarea>`);
    const all = steps(form, { store: "pg", x: ["b"], s: "b", t: "y" }, { x: "z" }) as Step[];
    expect(all.flatMap((s) => ("keys" in s ? s.keys : [])).filter((k) => !KEYS[k])).toEqual([]);
  });
});
