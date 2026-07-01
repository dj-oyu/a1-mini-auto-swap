import { test, expect } from "./fixtures";

// Seeded: job 6 (gridfinity_1x1.gcode.3mf) is failed with a retry_decision
// pending; job 2 (benchy_deck.gcode.3mf) is queued.

test.describe("card actions", () => {
  test("正常系: retry a failed job → 待機中 and its 対応待ち clears", async ({ page }) => {
    await page.goto("/");
    const card = page.locator(".card", { hasText: "gridfinity_1x1" });
    await expect(card.locator(".badge")).toHaveText("失敗");
    await expect(page.locator(".banner-count")).toHaveText("対応待ち 2");

    await card.getByRole("button", { name: "リトライ" }).click();

    // re-queued (attempts 1 ≤ cap) and the retry_decision pending resolved (2→1)
    await expect(page.locator(".card", { hasText: "gridfinity_1x1" }).locator(".badge")).toHaveText(
      "待機中",
    );
    await expect(page.locator(".banner-count")).toHaveText("対応待ち 1");
  });

  test("正常系: delete a queued job (two-step) removes the card", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".card")).toHaveCount(6);
    const card = page.locator(".card", { hasText: "benchy_deck" });

    const del = card.getByRole("button", { name: "削除" });
    await del.click(); // arms
    await expect(card.getByRole("button", { name: "本当に削除？" })).toBeVisible();
    await card.getByRole("button", { name: "本当に削除？" }).click(); // confirms

    await expect(page.locator(".card", { hasText: "benchy_deck" })).toHaveCount(0);
    await expect(page.locator(".card")).toHaveCount(5);
  });

  test("異常系: the printing job exposes no delete/retry", async ({ page }) => {
    await page.goto("/");
    const printingCard = page.locator(".card", { hasText: "benchy_hull" });
    await expect(printingCard.locator(".badge")).toHaveText("印刷中");
    await expect(printingCard.getByRole("button", { name: "削除" })).toHaveCount(0);
    await expect(printingCard.getByRole("button", { name: "リトライ" })).toHaveCount(0);
  });
});
