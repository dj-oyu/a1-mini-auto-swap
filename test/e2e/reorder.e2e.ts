import { test, expect } from "./fixtures";

// Seeded queue order: benchy_hull(printing), benchy_deck(queued),
// gridfinity_2x2(queued), gridfinity_baseplate(processing), ...

async function order(page: import("@playwright/test").Page): Promise<string[]> {
  return page.locator(".queue .card .filename").allInnerTexts();
}

test.describe("queue reordering", () => {
  test("正常系: moving a plate down persists the new order", async ({ page }) => {
    await page.goto("/");
    const before = await order(page);
    const deckIdx = before.findIndex((t) => t.includes("benchy_deck"));
    expect(before[deckIdx + 1]).toContain("gridfinity_2x2");

    // move benchy_deck down → it should swap with gridfinity_2x2
    await page
      .locator(".card", { hasText: "benchy_deck" })
      .getByRole("button", { name: "下へ" })
      .click();

    await expect
      .poll(async () => {
        const o = await order(page);
        const a = o.findIndex((t) => t.includes("benchy_deck"));
        const b = o.findIndex((t) => t.includes("gridfinity_2x2"));
        return a > b; // deck now after 2x2
      })
      .toBe(true);

    // survives a full reload (persisted to positions)
    await page.reload();
    const after = await order(page);
    const a = after.findIndex((t) => t.includes("benchy_deck"));
    const b = after.findIndex((t) => t.includes("gridfinity_2x2"));
    expect(a).toBeGreaterThan(b);
  });

  test("異常系: printing and terminal cards have no move buttons", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.locator(".card", { hasText: "benchy_hull" }).getByRole("button", { name: "上へ" }),
    ).toHaveCount(0);
    await expect(
      page.locator(".card", { hasText: "benchy_chimney" }).getByRole("button", { name: "上へ" }),
    ).toHaveCount(0);
  });
});
