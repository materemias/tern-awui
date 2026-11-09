import { describe, expect, test } from "bun:test";
import { parseAskForm } from "./ask-form";

describe("parseAskForm", () => {
  test("omp's own example: a radio group under its legend, then a labelled number", () => {
    const fields = parseAskForm(`<form>
  <p>Sessions live in memory and are lost on restart.</p>
  <fieldset>
    <legend>Session store</legend>
    <label><input type="radio" name="store" value="sqlite" checked> SQLite: one file, no new service</label>
    <label><input type="radio" name="store" value="redis"> Redis: shared across instances, needs ops</label>
  </fieldset>
  <label>Session lifetime (days) <input type="number" name="ttl_days" value="30" min="1"></label>
</form>`);
    expect(fields).toEqual([
      {
        kind: "choice",
        name: "store",
        question: "Session store",
        multi: false,
        select: false,
        other: true,
        options: [
          { value: "sqlite", label: "SQLite: one file, no new service", checked: true, disabled: false },
          { value: "redis", label: "Redis: shared across instances, needs ops", checked: false, disabled: false },
        ],
      },
      { kind: "text", name: "ttl_days", question: "Session lifetime (days)", multiline: false, value: "30" },
    ]);
  });

  test("a group's question is the text just before it; a field without any falls back to its name", () => {
    const fields = parseAskForm(`<p>Context.</p><p>Which &amp; why?</p>
      <label><input type="checkbox" name="x" value="a"> A</label><label><input type="checkbox" name="x" value="b"> B</label>
      <select name="db_kind"><option>pg</option><option>mysql</option></select>`);
    expect(fields.map((f) => f.question)).toEqual(["Which & why?", "db_kind"]);
  });

  test("every HTML entity decodes, in values, labels and text", () => {
    const [field] = parseAskForm(`<p>Caf&eacute; &hellip;&nbsp;or&#x20;tea?</p><label><input type="radio" name="d" value="caf&eacute;&amp;co"> Caf&eacute;</label><label><input type="radio" name="d" value="t"> T</label>`);
    expect(field).toMatchObject({ question: "Café … or tea?", options: [{ value: "café&co", label: "Café" }, { value: "t" }] });
  });

  test("a group with its own Other option, a single option and dropdowns get no free-text Other", () => {
    const fields = parseAskForm(`<label><input type="radio" name="a" value="1"> One</label><label><input type="radio" name="a" value="o"> Other (say)</label>
      <label><input type="checkbox" name="b"> Only</label>
      <select name="c"><option>x</option><option>y</option></select>`);
    expect(fields.map((f) => f.kind === "choice" && f.other)).toEqual([false, false, false]);
    // A lone box's label asks the question; its value defaults to "on".
    expect(fields[1]).toMatchObject({ question: "Only", options: [{ value: "on", label: "Only" }] });
  });

  test("dropdowns: unclosed options, text as the value, the first enabled option preselected", () => {
    const [single, multi] = parseAskForm(`<select name="s"><option disabled>-<option value="b">Bee<option>Cee</select>
      <select name="m" multiple><option>x<option selected>y</select>`);
    expect(single).toMatchObject({ select: true, multi: false, options: [
      { value: "-", checked: false, disabled: true },
      { value: "b", label: "Bee", checked: true },
      { value: "Cee", checked: false },
    ] });
    expect(multi).toMatchObject({ select: true, multi: true, options: [{ value: "x", checked: false }, { value: "y", checked: true }] });
  });

  test("labels by `for`, aria-label, or the name; textareas keep their text after the first newline", () => {
    const fields = parseAskForm(`<label for="n">Your name</label><input id="n" name="who">
      <input name="mail_to" type="email"><input name="q" aria-label="Query">
      <textarea name="t">
a &lt; b
c</textarea>`);
    expect(fields.map((f) => f.question)).toEqual(["Your name", "mail to", "Query", "t"]);
    expect(fields[3]).toMatchObject({ multiline: true, value: "a < b\nc" });
  });

  test("a `for` label that also wraps its control keeps it; attributes may follow a quote unspaced", () => {
    const fields = parseAskForm(`<label for="x">Name <input id="x" name="x"></label>
      <label><input type="radio"name="r"value="a"> A</label><label><input type="radio" name="r" value="b"> B</label>`);
    expect(fields).toMatchObject([
      { kind: "text", name: "x", question: "Name" },
      { kind: "choice", name: "r", options: [{ value: "a" }, { value: "b" }] },
    ]);
  });

  test("a rule or an empty picture between a caption and its field keeps the caption; a real picture drops it", () => {
    const group = `<label><input type="checkbox" name="x" value="a"> A</label><label><input type="checkbox" name="x" value="b"> B</label>`;
    const questions = (between: string) => parseAskForm(`<p>Which?</p>${between}${group}`).map((f) => f.question);
    expect(questions("<hr>")).toEqual(["Which?"]);
    expect(questions(`<img alt="">`)).toEqual(["Which?"]);
    expect(questions(`<img src="a.png" alt="">`)).toEqual(["x"]);
  });

  test("hidden, button and file inputs, and controls in skipped elements, aren't fields", () => {
    const fields = parseAskForm(`<input type="hidden" name="h"><input type="submit"><input type="file" name="f">
      <template><input name="tpl"></template><button><input name="inbtn"></button><script>"<input name=s>"</script><!-- <input name="c"> -->
      <input name="kept">`);
    expect(fields.map((f) => f.name)).toEqual(["kept"]);
  });
});
