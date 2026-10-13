// Bar charts under markdown tables, like omp draws them in the terminal: one panel per measure,
// one bar per option, each panel scaled on its own, the best value marked when the measure's
// direction is clear from its name. omp picks its headline with a model call; here only the
// deterministic "X is best on N of M measures" is shown.

type Dim = "bytes" | "time" | "percent" | "money" | "count";
export type Cell = { value: number; text: string; dim: Dim };
export type Series = { name: string; points: (Cell | null)[]; best: number | null };

const UNITS: Record<string, [Dim, number]> = {
  b: ["bytes", 1], kb: ["bytes", 1e3], kib: ["bytes", 1024], mb: ["bytes", 1e6], mib: ["bytes", 1024 ** 2],
  gb: ["bytes", 1e9], gib: ["bytes", 1024 ** 3], tb: ["bytes", 1e12], tib: ["bytes", 1024 ** 4],
  ns: ["time", 1e-9], µs: ["time", 1e-6], us: ["time", 1e-6], ms: ["time", 1e-3], s: ["time", 1], sec: ["time", 1],
  min: ["time", 60], h: ["time", 3600], "%": ["percent", 1], k: ["count", 1e3], m: ["count", 1e6], x: ["count", 1], "×": ["count", 1],
};
// A number or range, an optional unit, then nothing but a parenthetical: "0.23–1.04 MB (+29%)".
const CELL = /^[~≈<>]?\s*(\$)?\s*(-?[\d,]*\.?\d+)(?:\s*(?:–|—|-|to)\s*\$?(-?[\d,]*\.?\d+))?\s*([a-zµ%×]{1,3})?\s*(\(.*\))?\s*$/i;

export function parseCell(raw: string): Cell | null {
  const m = CELL.exec(raw.trim());
  if (!m) return null;
  const unit = (m[4] ?? "").toLowerCase();
  const known = UNITS[unit];
  if (unit && !known) return null;
  if (m[1] && unit && unit !== "k" && unit !== "m") return null;
  const lo = Number(m[2].replace(/,/g, ""));
  const hi = m[3] === undefined ? lo : Number(m[3].replace(/,/g, ""));
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 0 || hi < 0) return null;
  const [dim, scale] = m[1] ? (["money", known?.[1] ?? 1] as const) : (known ?? (["count", 1] as const));
  // A range sits at its middle; the label keeps it as written, minus any parenthetical.
  return { value: ((lo + hi) / 2) * scale, text: raw.trim().replace(/\s*\(.*\)\s*$/, ""), dim };
}

// Direction from the measure's name; null keeps the panel without a "best".
const LOWER = /\b(time|latency|duration|size|written|writes?|bytes|cost|price|errors?|fail(ed|ures?)?|memory|ram|cpu|overhead|extents|wait|delay|loss|tokens|lag|p\d\d)\b/i;
const HIGHER = /\b(reus(e|able)|throughput|speed|hits?|accuracy|score|success|coverage|saved|savings|uptime|revenue|profit|income|ops|qps|rps|fps|wins?|pass(ed|es)?)\b/i;

function bestOf(s: Series): number | null {
  // Direction only from the name, and only when it points one way ("error rate" names both).
  const lower = LOWER.test(s.name);
  const higher = HIGHER.test(s.name);
  const polarity = lower === higher ? null : lower ? "lower" : "higher";
  const vals = s.points.flatMap((p, i) => (p ? [{ i, v: p.value }] : []));
  if (!polarity || vals.length < 2) return null;
  vals.sort((a, b) => (polarity === "lower" ? a.v - b.v : b.v - a.v));
  return vals[0].v === vals[1].v ? null : vals[0].i;
}

/** Rows are measures when each row keeps one dimension and the columns mix them. */
export function seriesOf(header: string[], rows: string[][]): { categories: string[]; series: Series[] } | null {
  const grid = rows.map((r) => r.slice(1).map(parseCell));
  const numeric = grid.flat().filter(Boolean).length;
  if (numeric < 4) return null;
  const sameDim = (cells: (Cell | null)[]) => new Set(cells.flatMap((c) => (c ? [c.dim] : []))).size <= 1;
  const cols = header.slice(1).map((_, j) => grid.map((r) => r[j] ?? null));
  const byRow = grid.every(sameDim) && !cols.every(sameDim);
  const categories = byRow ? header.slice(1) : rows.map((r) => r[0]);
  const raw = byRow ? rows.map((r, i) => ({ name: r[0], points: grid[i] })) : header.slice(1).map((h, j) => ({ name: h, points: cols[j] }));
  const series = raw
    .filter((s) => sameDim(s.points) && s.points.filter(Boolean).length >= 2)
    .map((s) => {
      const out: Series = { name: s.name, points: categories.map((_, i) => s.points[i] ?? null), best: null };
      out.best = bestOf(out);
      return out;
    });
  if (!series.length || categories.length < 2 || categories.length > 12 || series.length > 16) return null;
  return { categories, series };
}

export function headline(categories: string[], series: Series[]): string {
  const wins = new Map<number, string[]>();
  for (const s of series) if (s.best !== null) wins.set(s.best, [...(wins.get(s.best) ?? []), s.name]);
  const [top] = [...wins].sort((a, b) => b[1].length - a[1].length);
  if (!top || top[1].length < 2) return "";
  const names = top[1];
  const what =
    names.length === series.length
      ? `all ${names.length} measures`
      : names.length <= 3 && names.join(", ").length <= 40
        ? names.slice(0, -1).join(", ") + " and " + names.at(-1)
        : `${names.length} of ${series.length} measures`;
  return `${categories[top[0]]} is best on ${what}`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function chartFor(table: HTMLTableElement): HTMLElement | null {
  const header = [...table.querySelectorAll("thead th")].map((c) => c.textContent?.trim() ?? "");
  const rows = [...table.querySelectorAll("tbody tr")].map((r) => [...r.children].map((c) => c.textContent?.trim() ?? ""));
  if (header.length < 2 || rows.length < 2) return null;
  const data = seriesOf(header, rows);
  if (!data) return null;
  const { categories, series } = data;
  const fig = el("div", "chart");
  const head = el("div", "chart-head");
  head.append(el("span", "chart-title", headline(categories, series)), el("span", "chart-note", "scaled per panel"));
  const legend = el("div", "chart-legend");
  categories.forEach((c, i) => {
    const item = el("span", `chart-key k${i % 6}`);
    item.append(el("i", ""), document.createTextNode(c));
    legend.append(item);
  });
  const panels = el("div", "chart-panels");
  for (const s of series) {
    const panel = el("div", "chart-panel");
    panel.append(el("div", "chart-name", s.name));
    const max = Math.max(...s.points.map((p) => p?.value ?? 0));
    // Room for the longest label (bold and "best" included) right of the longest bar.
    const room = Math.max(...s.points.map((p, i) => (p ? p.text.length * (s.best === i ? 1.15 : 1) + (s.best === i ? 6 : 0) : 0))) + 2;
    s.points.forEach((p, i) => {
      const line = el("div", "chart-row");
      if (p) {
        // The label rides right after the bar; the bar's scale leaves room for it.
        const bar = el("span", `chart-bar k${i % 6}`);
        bar.style.width = `calc((100% - ${room.toFixed(1)}ch) * ${max > 0 ? p.value / max : 0})`;
        line.append(bar, el("span", `chart-val${s.best === i ? " best" : ""}`, p.text));
        if (s.best === i) line.append(el("span", "chart-best", "best"));
      }
      panel.append(line);
    });
    panels.append(panel);
  }
  fig.append(head, legend, panels);
  return fig;
}

/** Puts a chart under every table in `root` that has one; tables already done are skipped. */
export function drawCharts(root: HTMLElement) {
  for (const table of root.querySelectorAll<HTMLTableElement>("table:not([data-charted])")) {
    table.dataset.charted = "";
    const fig = chartFor(table);
    if (fig) table.after(fig);
  }
}
