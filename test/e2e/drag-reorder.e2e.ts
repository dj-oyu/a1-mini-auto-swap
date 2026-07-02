import { test, expect } from "./fixtures";

async function order(page: import("@playwright/test").Page): Promise<string[]> {
  return page.locator(".queue .card .filename").allInnerTexts();
}

test.describe("drag-and-drop reorder", () => {
  test("正常系: dragging a plate's handle below another reorders + persists", async ({ page }) => {
    await page.goto("/");
    const before = await order(page);
    const a = before.findIndex((t) => t.includes("benchy_deck"));
    const b = before.findIndex((t) => t.includes("gridfinity_2x2"));
    expect(a).toBeLessThan(b); // deck currently above 2x2

    const handle = page.locator(".card", { hasText: "benchy_deck" }).locator("[data-drag-handle]");
    const target = page.locator(".card", { hasText: "gridfinity_baseplate" }); // a lower card
    const hb = (await handle.boundingBox())!;
    const tb = (await target.boundingBox())!;

    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    // move in steps to just below the target card's midpoint, then drop
    await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2 + 5, { steps: 8 });
    await page.mouse.up();

    // deck moved below 2x2; persists across reload
    await expect
      .poll(async () => {
        const o = await order(page);
        return o.findIndex((t) => t.includes("benchy_deck")) > o.findIndex((t) => t.includes("gridfinity_2x2"));
      })
      .toBe(true);

    await page.reload();
    const after = await order(page);
    expect(after.findIndex((t) => t.includes("benchy_deck"))).toBeGreaterThan(
      after.findIndex((t) => t.includes("gridfinity_2x2")),
    );
  });
});
