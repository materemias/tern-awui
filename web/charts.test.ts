import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { drawCharts, headline, parseCell, seriesOf, type Series } from "./charts";

GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(() => GlobalRegistrator.unregister());

describe("parseCell", () => {
  test.each([
    ["12", 12, "count"],
    ["1,234", 1234, "count"],
    ["1.5k", 1500, "count"],
    ["3x", 3, "count"],
    ["~3×", 3, "count"],
    ["12 ms", 0.012, "time"],
    ["2 min", 120, "time"],
    ["1.5 s", 1.5, "time"],
    ["4 KiB", 4096, "bytes"],
    ["3 MB", 3e6, "bytes"],
    ["42%", 42, "percent"],
    ["$4.50", 4.5, "money"],
    ["$1.5k", 1500, "money"],
    ["$2M", 2e6, "money"],
  ])("%s → %d %s", (raw, value, dim) => {
    const c = parseCell(raw)!;
    expect(c.value).toBeCloseTo(value, 9);
    expect(c.dim).toBe(dim as never);
  });

  test("a range sits at its middle and keeps its text, minus the parenthetical", () => {
    const c = parseCell("0.23–1.04 MB (+29%)")!;
    expect(c.value).toBeCloseTo(635_000, 3);
    expect(c.dim).toBe("bytes");
    expect(c.text).toBe("0.23–1.04 MB");
    expect(parseCell("10-20 ms")!.value).toBeCloseTo(0.015, 9);
    expect(parseCell("5 to 7 s")!.value).toBe(6);
    expect(parseCell("$10–$20")!).toMatchObject({ value: 15, dim: "money" });
  });

  test.each(["", "fast", "12 parsecs", "12 abc", "-5", "3 MB and more", "v1.2.3", "n/a", "$5 ms", "$3 MB", "$4%"])("%p is not a number", (raw) => {
    expect(parseCell(raw)).toBeNull();
  });
});

describe("seriesOf", () => {
  test("columns are the measures when rows mix units", () => {
    const d = seriesOf(
      ["Option", "Time", "Size"],
      [
        ["A", "12 ms", "3 MB"],
        ["B", "20 ms", "1 MB"],
      ],
    )!;
    expect(d.categories).toEqual(["A", "B"]);
    expect(d.series.map((s) => [s.name, s.best])).toEqual([
      ["Time", 0],
      ["Size", 1],
    ]);
  });

  test("rows are the measures when each row keeps one unit and columns mix", () => {
    const d = seriesOf(
      ["Measure", "A", "B", "C"],
      [
        ["Latency", "12 ms", "15 ms", "9 ms"],
        ["Size", "3 MB", "2 MB", "4 MB"],
        ["Accuracy", "91%", "95%", "90%"],
      ],
    )!;
    expect(d.categories).toEqual(["A", "B", "C"]);
    expect(d.series.map((s) => [s.name, s.best])).toEqual([
      ["Latency", 2],
      ["Size", 1],
      ["Accuracy", 1],
    ]);
  });

  test("best only when the name points one way", () => {
    const d = seriesOf(
      ["Option", "Throughput", "Time saved", "Widgets"],
      [
        ["A", "100", "5 s", "3"],
        ["B", "200", "9 s", "7"],
      ],
    )!;
    const best = Object.fromEntries(d.series.map((s) => [s.name, s.best]));
    // Higher is better; "time" and "saved" pull both ways; "widgets" says nothing.
    expect(best).toEqual({ Throughput: 1, "Time saved": null, Widgets: null });
  });

  test("currency multipliers keep costs comparable and select the cheaper option", () => {
    const data = seriesOf(["Option", "Cost", "Latency"], [["A", "$1.5k", "1 ms"], ["B", "$900", "2 ms"]])!;
    expect(data.series[0].points.map((p) => p?.value)).toEqual([1500, 900]);
    expect(data.series[0].best).toBe(1);
    expect(headline(data.categories, data.series)).toBe("");
  });

  test("a tie for best marks none; a lone value can't be best", () => {
    const d = seriesOf(
      ["Option", "Latency", "Cost"],
      [
        ["A", "10 ms", "$5"],
        ["B", "10 ms", "-"],
        ["C", "20 ms", "$3"],
      ],
    )!;
    expect(d.series.map((s) => [s.name, s.best])).toEqual([
      ["Latency", null],
      ["Cost", 2],
    ]);
  });

  test("a column mixing units, or with fewer than two numbers, is no measure", () => {
    const d = seriesOf(
      ["Option", "Latency", "Mixed", "Notes"],
      [
        ["A", "10 ms", "3 MB", "ok"],
        ["B", "12 ms", "4 s", "1"],
      ],
    )!;
    expect(d.series.map((s) => s.name)).toEqual(["Latency"]);
  });

  test("too few numbers, too few or too many options: no chart", () => {
    expect(seriesOf(["Option", "Notes"], [["A", "fast"], ["B", "slow"]])).toBeNull();
    expect(seriesOf(["Option", "Time"], [["A", "1 s"], ["B", "2 s"], ["C", "3 s"]])).toBeNull();
    const rows = (n: number) => Array.from({ length: n }, (_, i) => [`o${i}`, `${i + 1} s`]);
    expect(seriesOf(["Option", "Time"], rows(12))?.categories.length).toBe(12);
    expect(seriesOf(["Option", "Time"], rows(13))).toBeNull();
  });
});

describe("headline", () => {
  const s = (name: string, best: number | null): Series => ({ name, points: [], best });
  test("one option winning every measure", () => {
    expect(headline(["A", "B"], [s("Time", 0), s("Size", 0)])).toBe("A is best on all 2 measures");
  });
  test("two or three short names are listed", () => {
    expect(headline(["A", "B"], [s("Time", 1), s("Size", 1), s("Cost", 0)])).toBe("B is best on Time and Size");
    expect(headline(["A", "B"], [s("Time", 1), s("Size", 1), s("Cost", 1), s("Score", 0)])).toBe("B is best on Time, Size and Cost");
  });
  test("long or many names are counted", () => {
    const long = [s("Cold start latency in milliseconds", 0), s("Resident memory after warmup", 0), s("Cost", 1)];
    expect(headline(["A", "B"], long)).toBe("A is best on 2 of 3 measures");
    const many = ["a", "b", "c", "d"].map((n) => s(n, 0));
    expect(headline(["A", "B"], [...many, s("e", 1)])).toBe("A is best on 4 of 5 measures");
  });
  test("a single win or no winner: no headline", () => {
    expect(headline(["A", "B"], [s("Time", 0), s("Size", 1)])).toBe("");
    expect(headline(["A", "B"], [s("Time", null), s("Size", null)])).toBe("");
  });
});

describe("drawCharts", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });
  function table(header: string[], rows: string[][]): HTMLElement {
    const root = document.createElement("div");
    root.innerHTML = `<table><thead><tr>${header.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows
      .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
      .join("")}</tbody></table>`;
    document.body.append(root);
    return root;
  }

  test("draws one panel per measure under the table, best marked", () => {
    const root = table(
      ["Option", "Time", "Size"],
      [
        ["A", "12 ms", "4 MB"],
        ["B", "24 ms", "2 MB"],
      ],
    );
    drawCharts(root);
    const chart = root.querySelector("table")!.nextElementSibling!;
    expect(chart.className).toBe("chart");
    expect([...chart.querySelectorAll(".chart-key")].map((k) => k.textContent)).toEqual(["A", "B"]);
    const panels = [...chart.querySelectorAll(".chart-panel")];
    expect(panels.map((p) => p.querySelector(".chart-name")!.textContent)).toEqual(["Time", "Size"]);
    const bestIn = (p: Element) => p.querySelector(".chart-val.best")?.textContent;
    expect(panels.map(bestIn)).toEqual(["12 ms", "2 MB"]);
    expect(chart.querySelectorAll(".chart-best").length).toBe(2);
    // Each panel is scaled on its own: the longest bar is full, half the value half as long.
    const widths = [...panels[0].querySelectorAll<HTMLElement>(".chart-bar")].map((b) => b.style.width);
    expect(widths[0]).toMatch(/\* 0\.5\)$/);
    expect(widths[1]).toMatch(/\* 1\)$/);
    expect(chart.querySelector(".chart-title")!.textContent).toBe("");
  });

  test("a table drawn once is skipped next time", () => {
    const root = table(
      ["Option", "Time"],
      [
        ["A", "1 s"],
        ["B", "2 s"],
        ["C", "3 s"],
        ["D", "4 s"],
      ],
    );
    drawCharts(root);
    drawCharts(root);
    expect(root.querySelectorAll(".chart").length).toBe(1);
    expect(root.querySelector("table")!.hasAttribute("data-charted")).toBe(true);
  });

  test("tables without numbers get no chart, but are marked done", () => {
    const root = table(
      ["Name", "Role"],
      [
        ["Ann", "dev"],
        ["Bob", "ops"],
      ],
    );
    drawCharts(root);
    expect(root.querySelector(".chart")).toBeNull();
    expect(root.querySelector("table")!.hasAttribute("data-charted")).toBe(true);
  });

  test("a table added later is charted on the next pass", () => {
    const root = table(["Name", "Role"], [["Ann", "dev"], ["Bob", "ops"]]);
    drawCharts(root);
    const more = document.createElement("div");
    more.innerHTML = "<table><thead><tr><th>O</th><th>Errors</th></tr></thead><tbody><tr><td>A</td><td>3</td></tr><tr><td>B</td><td>1</td></tr><tr><td>C</td><td>2</td></tr><tr><td>D</td><td>5</td></tr></tbody></table>";
    root.append(more);
    drawCharts(root);
    expect(root.querySelectorAll(".chart").length).toBe(1);
    expect(more.querySelector(".chart-val.best")!.textContent).toBe("1");
  });
});
