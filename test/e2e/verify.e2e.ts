import { test, expect } from "./fixtures";

// 実機検証ガイド (/verify) E2E against the dev harness (fake deps: all-green
// diagnostics, IDLE printer). Covers page render + the two bits of real browser
// behaviour the unit tests can't: htmx auto-judge swap, and the physical-safety
// checkbox gate on the Stage 5 run button.
test.describe("verify wizard (/verify)", () => {
  test("renders the 7-stage wizard and the nav entry", async ({ page }) => {
    await page.goto("/verify");
    await expect(page.locator("h1")).toHaveText("実機検証ガイド");
    await expect(page.locator(".stage-card")).toHaveCount(7);
    await expect(page.locator('.stage-card[data-stage="1"]')).toContainText("TCP到達性");
    await expect(page.locator('.stage-card[data-stage="5"]')).toContainText("ドライリハーサル印刷");
    // every stage starts 未実施
    await expect(page.locator('.stage-card[data-stage="1"] .badge')).toHaveText("未実施");
    // nav link is present (also injected on the dashboard nav)
    await page.goto("/");
    await expect(page.locator('.nav a[href="/verify"]')).toBeVisible();
  });

  test("running diagnostics marks Stage 1-3 合格 and shows the PROT mode", async ({ page }) => {
    await page.goto("/verify");
    await page.getByRole("button", { name: /接続診断を実行/ }).click();
    await expect(page.locator('.stage-card[data-stage="1"] .badge')).toHaveText("合格");
    await expect(page.locator('.stage-card[data-stage="2"] .badge')).toHaveText("合格");
    await expect(page.locator('.stage-card[data-stage="3"] .badge')).toHaveText("合格");
    // spec 19 ★ PROT mode callout (harness fake reports the A1 PROT C fallback)
    await expect(page.locator(".prot-callout")).toContainText("PROT モード");
    await expect(page.locator(".prot-value")).toHaveText("C");
  });

  test("the dry-run button is disabled until all physical-safety boxes are checked", async ({ page }) => {
    await page.goto("/verify");
    const runBtn = page.locator("#verifyDryRun");
    await expect(runBtn).toBeDisabled();

    const boxes = page.locator("[data-verify-safety]");
    await expect(boxes).toHaveCount(3);
    await boxes.nth(0).check();
    await boxes.nth(1).check();
    await expect(runBtn).toBeDisabled(); // still one unchecked
    await boxes.nth(2).check();
    await expect(runBtn).toBeEnabled(); // all three → armed
  });
});
