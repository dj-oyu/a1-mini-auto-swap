import { test, expect, validThreemf, invalidThreemf } from "./fixtures";

test.describe("upload", () => {
  test("正常系: uploading a valid 3mf creates a job and auto-opens confirm", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".card")).toHaveCount(6);

    await page.setInputFiles("#fileInput", {
      name: "model.gcode.3mf",
      mimeType: "application/octet-stream",
      buffer: validThreemf(),
    });

    // the confirm modal for the new job (id 7) opens automatically
    const modal = page.locator("#modal .modal-box");
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("フィラメント確認");
    // the extractor found 2 filaments → 2 slot dropdowns
    await expect(modal.locator("select[data-slot]")).toHaveCount(2);

    // a new card appeared in the queue
    await expect(page.locator(".card", { hasText: "model.gcode.3mf" })).toBeVisible();
    await expect(page.locator(".card")).toHaveCount(7);

    // confirming queues it
    await modal.locator('select[data-slot="1"]').selectOption("0");
    await modal.getByRole("button", { name: "この内容で確定" }).click();
    await expect(page.locator("#modal .modal-box")).toHaveCount(0);
    await expect(page.locator(".card", { hasText: "model.gcode.3mf" }).locator(".badge")).toHaveText(
      "待機中",
    );
  });

  test("異常系: an invalid file surfaces an error and creates no job", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".card")).toHaveCount(6);

    await page.setInputFiles("#fileInput", {
      name: "broken.gcode.3mf",
      mimeType: "application/octet-stream",
      buffer: invalidThreemf(),
    });

    await expect(page.locator("#uploadStatus")).toContainText("アップロード失敗");
    // no modal, no new card
    await expect(page.locator("#modal .modal-box")).toHaveCount(0);
    await expect(page.locator(".card")).toHaveCount(6);
  });
});
