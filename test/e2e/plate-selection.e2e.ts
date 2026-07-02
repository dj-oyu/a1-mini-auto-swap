import { test, expect, multiPlateThreemf, validThreemf } from "./fixtures";

// Multi-plate 3mf upload (plate-selection): a project exported with "all
// plates" ships one Metadata/plate_N.gcode per plate. The confirm modal must
// offer a picker; a single-plate upload must keep behaving exactly as before
// (no picker — auto-discovery at dispatch time, unchanged).

test.describe("plate selection (multi-plate 3mf upload)", () => {
  test("正常系: a multi-plate upload offers a picker, and the choice is persisted", async ({
    page,
    request,
  }) => {
    await page.goto("/");

    await page.setInputFiles("#fileInput", {
      name: "allplates.gcode.3mf",
      mimeType: "application/octet-stream",
      buffer: multiPlateThreemf(),
    });

    const modal = page.locator("#modal .modal-box");
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("印刷対象プレート");
    const radios = modal.locator('input[name="plate"]');
    await expect(radios).toHaveCount(2);
    // the first plate is checked by default
    await expect(modal.locator('input[data-plate="plate_1"]')).toBeChecked();
    // static per-plate estimates are shown (no thumbnail dependency)
    await expect(modal).toContainText("1時間");
    await expect(modal).toContainText("30分");

    // pick the second plate instead
    await modal.locator('input[data-plate="plate_2"]').check();
    await modal.locator('select[data-slot="1"]').selectOption("0");
    await modal.getByRole("button", { name: "この内容で確定" }).click();
    await expect(page.locator("#modal .modal-box")).toHaveCount(0);

    const card = page.locator(".card", { hasText: "allplates.gcode.3mf" });
    await expect(card.locator(".badge")).toHaveText("待機中");

    // the selection was persisted to the job row (not just the UI)
    const jobId = await card.getAttribute("data-job-id");
    const res = await request.get(`/api/queue/${jobId}`);
    expect((await res.json()).selected_plate).toBe("plate_2");
  });

  test("回帰: a single-plate upload shows no picker (unchanged behaviour)", async ({ page }) => {
    await page.goto("/");

    await page.setInputFiles("#fileInput", {
      name: "single.gcode.3mf",
      mimeType: "application/octet-stream",
      buffer: validThreemf(),
    });

    const modal = page.locator("#modal .modal-box");
    await expect(modal).toBeVisible();
    await expect(modal).not.toContainText("印刷対象プレート");
    await expect(modal.locator('input[name="plate"]')).toHaveCount(0);
  });
});
