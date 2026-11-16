import { expect, test } from "bun:test";
import { shareText } from "./share";

test("shared title, text and link make one draft, a link the text already holds only once", () => {
  expect(shareText("Bug", "see https://x.test/1", "https://x.test/1")).toBe("Bug\n\nsee https://x.test/1");
  expect(shareText("", " note ", "")).toBe("note");
  expect(shareText("", "", "")).toBe("");
});
