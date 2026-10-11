import { describe, expect, test } from "bun:test";
import { answerSteps, KEYS, MAX_IMAGE_CHARS, MAX_PROMPT_IMAGES, promptImages, type Step } from "./input";
import type { AskEntry, AskQuestion } from "./transcript";

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
  const q = (options: number, multi = false): AskQuestion => ({
    question: "?",
    multi,
    recommended: 0,
    options: Array.from({ length: options }, (_, i) => ({ label: `o${i}`, description: "" })),
  });
  const ask = (...questions: AskQuestion[]): AskEntry => ({ role: "ask", id: "ask1", questions, answer: null, ts: 0 });
  const steps = (a: AskEntry, answers: unknown[]) => answerSteps(a, { id: "ask1", answers }) as Step[];
  const up = (n: number) => Array(n).fill("Up");
  const down = (n: number) => Array(n).fill("Down");

  test("refuses a missing, answered or different ask", () => {
    expect(answerSteps(undefined, { id: "ask1", answers: [{ option: 0 }] })).toBe("this question is no longer open");
    expect(answerSteps({ ...ask(q(2)), answer: "done" }, { id: "ask1", answers: [{ option: 0 }] })).toBe("this question is no longer open");
    expect(answerSteps(ask(q(2)), { id: "other", answers: [{ option: 0 }] })).toBe("this question is no longer open");
  });

  test("needs one answer per question", () => {
    expect(answerSteps(ask(q(2), q(2)), { id: "ask1", answers: [{ option: 0 }] })).toBe("answer every question");
    expect(answerSteps(ask(q(2)), { id: "ask1" })).toBe("answer every question");
  });

  test("names the first question without a valid answer", () => {
    const a = ask(q(2), q(3), q(2, true));
    expect(answerSteps(a, { id: "ask1", answers: [{ option: 0 }, { option: 3 }, { picks: [] }] })).toBe("question 2 has no valid answer");
    expect(answerSteps(a, { id: "ask1", answers: [{ option: -1 }, { option: 0 }, { picks: [] }] })).toBe("question 1 has no valid answer");
    expect(answerSteps(a, { id: "ask1", answers: [{ option: "1" }, { option: 0 }, { picks: [] }] })).toBe("question 1 has no valid answer");
    expect(answerSteps(a, { id: "ask1", answers: [{ option: 0 }, { option: 0 }, { picks: 1 }] })).toBe("question 3 has no valid answer");
    // Typed text answers any question, even without an option.
    expect(answerSteps(a, { id: "ask1", answers: [{ other: "mine" }, { option: 2 }, { other: "x" }] })).toBeArray();
    expect(answerSteps(a, { id: "ask1", answers: [{ other: "   " }, { option: 0 }, { picks: [] }] })).toBe("question 1 has no valid answer");
  });

  test("a single option: Up to the top whatever the cursor, Down to it, Enter", () => {
    expect(steps(ask(q(3)), [{ option: 2 }])).toEqual([{ keys: [...up(3), ...down(2), "Enter"] }]);
    expect(steps(ask(q(3)), [{ option: 0 }])).toEqual([{ keys: [...up(3), "Enter"] }]);
  });

  test("typed text: to the Other row, Enter, the text, Enter", () => {
    expect(steps(ask(q(2)), [{ other: "  my own  " }])).toEqual([{ keys: [...up(2), ...down(2), "Enter"] }, { text: "my own" }, { keys: ["Enter"] }]);
  });

  test("multi picks toggle each row once in order, then Enter", () => {
    expect(steps(ask(q(4, true)), [{ picks: [3, 1, 3, 9, -1, "2"] }])).toEqual([{ keys: [...up(4), ...down(1), "space", ...down(2), "space", "Enter"] }]);
    // No picks still resets the cursor before Enter.
    expect(steps(ask(q(2, true)), [{ picks: [] }])).toEqual([{ keys: [...up(2), "Enter"] }]);
  });

  test("a lone multi question with typed text ends on Review, which Enter submits", () => {
    expect(steps(ask(q(3, true)), [{ picks: [1], other: "extra" }])).toEqual([
      { keys: [...up(3), ...down(1), "space", ...down(2), "Enter"] },
      { text: "extra" },
      { keys: ["Enter"] },
      { keys: ["Enter"] },
    ]);
  });

  test("several questions answer in order and finish on the Review tab", () => {
    expect(steps(ask(q(2), q(2, true), q(1)), [{ option: 1 }, { picks: [0], other: "and this" }, { other: "typed" }])).toEqual([
      { keys: [...up(2), ...down(1), "Enter"] },
      { keys: [...up(2), "space", ...down(2), "Enter"] },
      { text: "and this" },
      { keys: ["Enter"] },
      { keys: [...up(1), ...down(1), "Enter"] },
      { text: "typed" },
      { keys: ["Enter"] },
      { keys: ["Enter"] },
    ]);
  });

  test("every key it produces is one /keys accepts", () => {
    const all = steps(ask(q(5), q(5, true), q(3, true)), [{ option: 4 }, { picks: [0, 2, 4], other: "t" }, { picks: [1] }]);
    const keys = all.flatMap((s) => ("keys" in s ? s.keys : []));
    expect(keys.filter((k) => !KEYS[k])).toEqual([]);
  });
});
