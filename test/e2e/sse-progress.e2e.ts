import { test, expect } from "./fixtures";

test.describe("live progress over SSE", () => {
  test("正常系: a pushed progress frame updates the printing header", async ({ page, request }) => {
    await page.goto("/");
    // initial fetch shows the seeded fake status (42%)
    await expect(page.locator(".printing .pct")).toContainText("42%");

    // push a new measured status over SSE (dev hook) → header updates, no reload
    await request.post("/__dev/progress?job_id=1&percent=88&remaining_min=5");
    await expect(page.locator(".printing .pct")).toContainText("88%");
    await expect(page.locator(".printing .pct")).toContainText("実測");
    await expect(page.locator(".printing .eta-clock")).toContainText("ETA");
  });
});
