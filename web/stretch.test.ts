import { describe, expect, test } from "bun:test";
import { parse, stretches } from "./stretch-core";
import { liveText, openText, withOpen } from "./stretch";

// Keys are the bridge contract with omp-stretch's stretch.ts: the phone and the pane must name each
// stretch alike. These pin the format; a change here needs the same change in omp-stretch.
describe("stretch keys", () => {
  test("nested keys carry the parent, repeated siblings are numbered", () => {
    const parts = parse("{{a|a {{b|b x}}}} and {{a|a y}}");
    expect(stretches(parts).map((s) => s.key)).toEqual(["a", "a › b", "a~2"]);
  });

  test("a written `a~2` and a separator inside a short form never share a key", () => {
    expect(stretches(parse("{{a|a 1}} {{a|a 2}} {{a~2|a~2 3}}")).map((s) => s.key)).toEqual(["a", "a~2", "a~2~2"]);
    expect(stretches(parse("{{a › b|x}} {{a|{{b|y}}}}")).map((s) => s.key)).toEqual(["a > b", "a", "a › b"]);
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
