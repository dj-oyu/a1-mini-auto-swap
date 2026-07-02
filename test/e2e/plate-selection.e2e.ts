import { test, expect, multiPlateThreemf, validThreemf } from "./fixtures";

// Multi-plate 3mf upload (plate-multiselect): a project exported with "all
// plates" ships one Metadata/plate_N.gcode per plate. The confirm modal offers
// an ORDERED SEQUENCE BUILDER (palette chips append → an ordered list, order +
// repeats significant) that fans out to one queued job per sequence element. A
// single-plate upload keeps behaving exactly as before (no builder).

test.describe("plate selection — sequence builder (multi-plate 3mf upload)", () => {
  test("正常系: build an ordered sequence with a repeat → fans out to N queued jobs", async ({
    page,
    request,
  }) => {
    await page.goto("/");

    await page.setInputFiles("#fileInput", {
      name: "allplates.gcode.3mf",
      mimeType: "application/octet-stream",
      buffer: multiPlateThreemf(), // plate_1 (3600s) + plate_2 (1800s)
    });

    const modal = page.locator("#modal .modal-box");
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("印刷シーケンス");
    // palette: one chip per printable plate, plus 全追加
    await expect(modal.locator("[data-plate-add]")).toHaveCount(2);
    await expect(modal.locator("[data-plate-add-all]")).toHaveCount(1);
    // static per-plate estimates are shown (no thumbnail dependency)
    await expect(modal).toContainText("1時間");
    await expect(modal).toContainText("30分");
    // the sequence starts EMPTY (build a word, don't remove rows)
    await expect(modal.locator("[data-seq-item]")).toHaveCount(0);

    // build the ordered sequence [plate_1, plate_2, plate_1] by clicking chips
    // (plate_1 added twice → a repeat, like spelling B,O,B)
    await modal.locator('[data-plate-add="plate_1"]').click();
    await modal.locator('[data-plate-add="plate_2"]').click();
    await modal.locator('[data-plate-add="plate_1"]').click();
    await expect(modal.locator("[data-seq-item]")).toHaveCount(3);

    await modal.locator('select[data-slot="1"]').selectOption("0");
    await modal.getByRole("button", { name: "この内容で確定" }).click();
    await expect(page.locator("#modal .modal-box")).toHaveCount(0);

    // fan-out: three queued jobs for the same file, in sequence order
    const cards = page.locator(".card", { hasText: "allplates.gcode.3mf" });
    await expect(cards).toHaveCount(3);

    const res = await request.get("/api/queue");
    const { jobs } = (await res.json()) as {
      jobs: Array<{ filename: string; selected_plate: string | null }>;
    };
    const seq = jobs
      .filter((j) => j.filename === "allplates.gcode.3mf")
      .map((j) => j.selected_plate);
    expect(seq).toEqual(["plate_1", "plate_2", "plate_1"]); // order + repeat preserved
  });

  test("回帰: a single-plate upload shows no sequence builder (unchanged behaviour)", async ({
    page,
  }) => {
    await page.goto("/");

    await page.setInputFiles("#fileInput", {
      name: "single.gcode.3mf",
      mimeType: "application/octet-stream",
      buffer: validThreemf(),
    });

    const modal = page.locator("#modal .modal-box");
    await expect(modal).toBeVisible();
    await expect(modal).not.toContainText("印刷シーケンス");
    await expect(modal.locator("[data-plate-seq]")).toHaveCount(0);
    await expect(modal.locator("[data-plate-add]")).toHaveCount(0);
  });
});
