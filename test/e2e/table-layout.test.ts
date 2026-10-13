import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { Extension, type Sandbox } from "../server-harness";
import { Transcript } from "../fixtures";
import { CHROMIUM, closeBrowser, launch, startSandbox } from "./helpers";

// A descriptive table: short labels beside long prose and inline code.
const PROSE = `Implemented in \`src/checkout.ts\`. **Orders are only submitted after the price refresh settles; no request carries a stale \`total\`.** Shared \`money.ts\`, the cart and the admin pages were not changed.

| Feature | Implemented behavior |
| --- | --- |
| Price source | \`priceAt\` supplies the base for discounts, \`tax\` and shipping totals. |
| Coupons | Percentage coupons apply from \`1%\` through \`90%\`. An omitted \`limit\` defaults to one use per customer; \`limit=0\` rejects. Gift cards reject coupons because stacking is unavailable. |
| Bulk carts | Customer + store + session-scoped buffers. \`bulk=start\` opens a batch; \`bulk=end\` submits it. Line items are batched, then stock reservations are sent separately. Abandoned batches expire after five minutes. |
| Refunds | A refund remains linked to its order, with separate **partial** and full refund records. Supports \`card\` and \`voucher\` payouts, plus store \`credit\`. Refund-only \`ro=1\` lines keep the original currency. |
| Rounded price | \`round=0.05\` uses only the latest published price list and caches it until the next update. Stale lists reject. |
| Stock caching | One frozen snapshot per bulk batch; short-lived caching outside bulk. Inventory changes invalidate old plans and snapshots. |
| Fee reserve | Card-based totals reserve processing fees using the conservative **2.9% base rate**. Fixed amounts and percentage discounts keep their units. |
| Cancellation | \`cancel=order\` keeps reserved stock until the payment is voided. |

**Verification:** 181 tests passed. The real cart parser, order queue and HTTP transport were exercised offline, including signatures, mixed batch outcomes, refund payloads and dry runs with zero writes. Payloads were checked against the payment provider's schema.`;

const NUMERIC = `| Store | Price | Quantity | Notional | Margin | Fees | Profit | Balance |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Store A | 123456.123456 | 987654.123456 | 121932631137.0001 | 123456.123456 | 3456.123456 | 456789.123456 | 987654321.123456 |`;

async function measureProse(page: Page) {
  return page.locator(".assistant table").first().evaluate((table) => {
    const message = table.closest(".assistant");
    const scroll = table.closest(".scroll");
    const cell = table.querySelector("tbody tr:nth-child(3) td:nth-child(2)");
    const header = table.querySelector("th:last-child");
    if (!message || !scroll || !cell || !header) throw new Error("Prose table layout missing");
    const range = document.createRange();
    range.selectNodeContents(cell);
    const rects = [...range.getClientRects()];
    const tops = rects.map((rect) => rect.top).sort((a, b) => a - b);
    const lineHeight = parseFloat(getComputedStyle(cell).lineHeight);
    const box = table.getBoundingClientRect();
    const cellBox = cell.getBoundingClientRect();
    const messageBox = message.getBoundingClientRect();
    const scrollBox = scroll.getBoundingClientRect();
    return {
      width: box.width,
      available: messageBox.width,
      leftGutter: messageBox.left - scrollBox.left,
      rightGutter: scrollBox.right - messageBox.right,
      clientWidth: table.clientWidth,
      scrollWidth: table.scrollWidth,
      headerRight: header.getBoundingClientRect().right,
      tableRight: box.right,
      cellWidth: cellBox.width,
      cellClientWidth: cell.clientWidth,
      cellScrollWidth: cell.scrollWidth,
      lines: tops.filter((top, index) => index === 0 || top - tops[index - 1] > lineHeight / 2).length,
      textFits: rects.every((rect) => rect.left >= cellBox.left - 1 && rect.right <= cellBox.right + 1),
      viewport: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
}

describe.skipIf(!CHROMIUM)("markdown table layout", () => {
  let s: Sandbox;
  beforeAll(async () => {
    s = await startSandbox((s) => {
      s.transcript = new Transcript(s.session, `${s.home}/alpha`);
      s.prompt = s.transcript.user("Show implemented behavior", 1000);
      s.leaf = s.transcript.say(`${PROSE}\n\n${NUMERIC}`, 2000);
      writeFileSync(s.transcriptPath, s.transcript.text());
    });
    await new Extension(s).connect();
  }, 20_000);
  afterAll(async () => {
    await closeBrowser();
    await s?.close();
  });

  async function open(width: number) {
    const context = await (await launch()).newContext({
      viewport: { width, height: 900 },
      isMobile: width < 500,
      hasTouch: width < 500,
      extraHTTPHeaders: s.headers,
      serviceWorkers: "block",
    });
    try {
      const page = await context.newPage();
      await page.goto(`${s.base}/#/b/1`);
      await page.locator(".assistant table").first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      return { context, page };
    } catch (error) {
      await context.close();
      throw error;
    }
  }

  test.each([1400, 1800, 1920])("long prose fills the centered desktop reading column at %ipx rather than a narrow card", async (width) => {
    const { context, page } = await open(width);
    try {
      const layout = await measureProse(page);
      expect(Math.abs(layout.leftGutter - layout.rightGutter)).toBeLessThan(2);
      expect(layout.width).toBeGreaterThanOrEqual(layout.available - 2);
      // Check the actual columns too: widening only the block's border does not fix the bug.
      expect(layout.headerRight).toBeGreaterThanOrEqual(layout.tableRight - 2);
      expect(layout.cellWidth).toBeGreaterThan(layout.available * 0.7);
      expect(layout.lines).toBeGreaterThan(1);
      expect(layout.lines).toBeLessThanOrEqual(3);
      expect(layout.cellScrollWidth).toBeLessThanOrEqual(layout.cellClientWidth);
      expect(layout.textFits).toBe(true);
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
      expect(layout.documentWidth).toBe(layout.viewport);
    } finally {
      await context.close();
    }
  });

  test.each([393, 412])("prose wraps and wide numeric tables scroll locally at %ipx", async (width) => {
    const { context, page } = await open(width);
    try {
      const layout = await measureProse(page);
      expect(layout.viewport).toBe(width);
      expect(layout.width).toBeGreaterThanOrEqual(layout.available - 2);
      expect(layout.width).toBeLessThanOrEqual(layout.available);
      expect(layout.lines).toBeGreaterThanOrEqual(4);
      expect(layout.cellWidth).toBeGreaterThan(layout.available * 0.65);
      expect(layout.textFits).toBe(true);
      expect(layout.cellScrollWidth).toBeLessThanOrEqual(layout.cellClientWidth);
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
      expect(layout.documentWidth).toBe(width);

      const numeric = await page.locator(".assistant table").nth(1).evaluate((table) => {
        const cells = [...table.querySelectorAll("tbody td")];
        const last = cells.at(-1);
        if (!last) throw new Error("Numeric table missing");
        table.scrollLeft = table.scrollWidth;
        return {
          scrollWidth: table.scrollWidth,
          clientWidth: table.clientWidth,
          scrollLeft: table.scrollLeft,
          lastRight: last.getBoundingClientRect().right,
          tableRight: table.getBoundingClientRect().right,
          values: cells.map((cell) => cell.textContent),
          cellWidths: cells.map((cell) => cell.getBoundingClientRect().width),
          documentWidth: document.documentElement.scrollWidth,
        };
      });
      expect(numeric.scrollWidth).toBeGreaterThan(numeric.clientWidth);
      expect(numeric.scrollLeft).toBeGreaterThan(0);
      expect(numeric.lastRight).toBeLessThanOrEqual(numeric.tableRight);
      expect(numeric.values).toEqual(["Store A", "123456.123456", "987654.123456", "121932631137.0001", "123456.123456", "3456.123456", "456789.123456", "987654321.123456"]);
      expect(numeric.cellWidths.every((cellWidth) => cellWidth >= 40)).toBe(true);
      expect(numeric.documentWidth).toBe(width);
    } finally {
      await context.close();
    }
  });
});
