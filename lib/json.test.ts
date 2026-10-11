import { expect, test } from "bun:test";
import { arr, num, obj, str } from "./json";

test("JSON boundary helpers never coerce wrong-shaped fields", () => {
  for (const value of [null, undefined, true, 3, "text", []]) expect(obj(value)).toEqual({});
  for (const value of [null, undefined, true, 3, "text", {}]) expect(arr(value)).toEqual([]);
  for (const value of [null, undefined, true, 3, [], {}]) expect(str(value, "fallback")).toBe("fallback");
  for (const value of [null, undefined, true, "42", [], {}]) expect(num(value)).toBe(0);
  expect(str("")).toBe("");
  expect(str(null)).toBe("");
  expect(num(-12.5)).toBe(-12.5);
});

test("valid JSON containers are retained without copying", () => {
  const record = { nested: { value: 1 }, list: [1, 2] };
  expect(obj(record)).toBe(record);
  expect(arr(record.list)).toBe(record.list);
  expect(str("abc")).toBe("abc");
});
