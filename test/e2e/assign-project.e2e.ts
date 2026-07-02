import { test, expect, validThreemf } from "./fixtures";

// Seeded: "Benchy Fleet" has 3 plates. Uploading a new plate and assigning it
// to that project in the confirm modal should grow it to 4 — wiring an
// uploaded plate into a project's sequential build from the UI.

test.describe("assign a plate to a project (confirm modal)", () => {
  test("正常系: upload → pick project → 確定 → project plate count grows", async ({ page }) => {
    await page.goto("/");
    await page.setInputFiles("#fileInput", {
      name: "extra.gcode.3mf",
      mimeType: "application/octet-stream",
      buffer: validThreemf(),
    });

    const modal = page.locator("#modal .modal-box");
    await expect(modal).toBeVisible();
    // assign to Benchy Fleet
    await modal.locator("select[data-project]").selectOption({ label: "Benchy Fleet" });
    await modal.locator('select[data-slot="1"]').selectOption("0");
    await modal.getByRole("button", { name: "この内容で確定" }).click();
    await expect(page.locator("#modal .modal-box")).toHaveCount(0);

    // the plate now belongs to Benchy Fleet (was 3 → now 4)
    await page.goto("/projects");
    await expect(page.locator(".proj-card", { hasText: "Benchy Fleet" })).toContainText("4 プレート");
  });

  test("正常系: the confirm modal defaults to （プロジェクトなし） for a fresh upload", async ({ page }) => {
    await page.goto("/");
    await page.setInputFiles("#fileInput", {
      name: "solo.gcode.3mf",
      mimeType: "application/octet-stream",
      buffer: validThreemf(),
    });
    const select = page.locator("#modal .modal-box select[data-project]");
    await expect(select).toBeVisible();
    await expect(select).toHaveValue(""); // no project by default
  });
});
