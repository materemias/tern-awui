import { describe, expect, test } from "bun:test";
import { liveText, openText, parse, stretches, withOpen } from "./stretch";

describe("stretch keys", () => {
  test("match omp's stretch.ts: nested keys carry the parent, repeated siblings are numbered", () => {
    const parts = parse("{{a|a {{b|b x}}}} and {{a|a y}}");
    expect(stretches(parts).map((s) => s.key)).toEqual(["a", "a › b", "a~2"]);
  });

  test("closing a stretch closes the ones nested in it, not a sibling sharing its prefix", () => {
    expect(withOpen(["a", "a › b", "ab"], "a", false)).toEqual(["ab"]);
    expect(withOpen(["a"], "a", true)).toEqual(["a"]);
  });
});

describe("views without links", () => {
  test("a reply being written shows short forms, even of a long form still arriving", () => {
    expect(liveText("Now {{x|x long}} and {{y|y half")).toBe("Now x and y");
  });

  test("a side answer shows every long form; code keeps its braces", () => {
    expect(openText("It {{fails|fails on a stale cache}}; see `{{a|b}}`.")).toBe("It fails on a stale cache; see `{{a|b}}`.");
  });
});
