import { test, expect, validThreemf } from "./fixtures";

test.describe("3D preview (正常系)", () => {
  test("clicking a card thumbnail opens the 3D preview modal", async ({ page }) => {
    await page.goto("/");
    // upload a job that has a thumbnail + mesh, then dismiss the auto confirm
    await page.setInputFiles("#fileInput", {
      name: "cube.gcode.3mf",
      mimeType: "application/octet-stream",
      buffer: validThreemf(),
    });
    await page.locator("#modal").getByRole("button", { name: "キャンセル" }).click();
    await expect(page.locator("#modal .modal-box")).toHaveCount(0);

    const card = page.locator(".card", { hasText: "cube.gcode.3mf" });
    await card.locator(".card-thumb").click();

    const modal = page.locator("#modal .modal-box");
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("3D プレビュー");
    // the viewer container is present (canvas if WebGL is available, else the
    // fallback thumbnail — either way, no crash)
    await expect(modal.locator(".viewer")).toBeVisible();

    await modal.getByRole("button", { name: "閉じる" }).click();
    await expect(page.locator("#modal .modal-box")).toHaveCount(0);
  });
});

test.describe("empty state (異常系 / エッジ)", () => {
  test("an empty queue shows the empty state and a calm banner", async ({ page, request }) => {
    await request.post("/__dev/reset?seed=0"); // override the seeded reset
    await page.goto("/");

    await expect(page.locator(".empty")).toHaveText("キューは空です");
    await expect(page.locator(".card")).toHaveCount(0);
    await expect(page.locator(".banner-count")).toHaveText("対応待ち 0");
    await expect(page.locator(".banner.calm")).toBeVisible();
    await expect(page.locator(".printing")).toHaveCount(0); // nothing printing
    await expect(page.locator(".chip")).toContainText("ストッカー未設定");
  });
});
