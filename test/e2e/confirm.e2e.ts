import { test, expect } from "./fixtures";

// The seeded processing job (id 4) is gridfinity_baseplate.gcode.3mf with a
// filament_confirm pending — the filament-confirm hot path.

test.describe("filament confirm (正常系)", () => {
  test("confirm sets the AMS mapping and moves the job to 待機中", async ({ page }) => {
    await page.goto("/");
    const card = page.locator(".card", { hasText: "gridfinity_baseplate" });
    await expect(card.locator(".badge")).toHaveText("確認待ち");
    await expect(page.locator(".banner-count")).toHaveText("対応待ち 2");

    await page.locator(".card-confirm").click();

    const modal = page.locator("#modal .modal-box");
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("フィラメント確認");
    await expect(modal.locator("select[data-slot]")).toHaveCount(2);

    await modal.locator('select[data-slot="1"]').selectOption("1"); // AMS 2
    await modal.locator('select[data-slot="2"]').selectOption("2"); // AMS 3
    await modal.getByRole("button", { name: "この内容で確定" }).click();

    // modal closes, dashboard refreshes: job now 待機中, its confirm button gone,
    // and the filament_confirm pending is resolved (banner 2 → 1)
    await expect(page.locator("#modal .modal-box")).toHaveCount(0);
    await expect(page.locator(".card", { hasText: "gridfinity_baseplate" }).locator(".badge")).toHaveText(
      "待機中",
    );
    await expect(page.locator(".card-confirm")).toHaveCount(0);
    await expect(page.locator(".banner-count")).toHaveText("対応待ち 1");
  });

  test("cancel closes the modal without changing state", async ({ page }) => {
    await page.goto("/");
    await page.locator(".card-confirm").click();
    await expect(page.locator("#modal .modal-box")).toBeVisible();

    await page.locator("#modal").getByRole("button", { name: "キャンセル" }).click();

    await expect(page.locator("#modal .modal-box")).toHaveCount(0);
    await expect(page.locator(".card", { hasText: "gridfinity_baseplate" }).locator(".badge")).toHaveText(
      "確認待ち",
    );
    await expect(page.locator(".banner-count")).toHaveText("対応待ち 2");
  });
});
