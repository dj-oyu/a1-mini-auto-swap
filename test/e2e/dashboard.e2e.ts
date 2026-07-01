import { test, expect } from "./fixtures";

test.describe("dashboard (正常系)", () => {
  test("renders the seeded queue, stocker, banner and printing header", async ({ page }) => {
    await page.goto("/");

    // header + live printing card
    await expect(page.locator("h1")).toHaveText("印刷キュー");
    const printing = page.locator(".printing");
    await expect(printing).toContainText("benchy_hull.gcode.3mf");
    await expect(printing.locator(".badge")).toHaveText("印刷中");

    // stocker chip and 対応待ち banner (2 seeded unresolved actions)
    await expect(page.locator(".chip")).toContainText("プレート 5/8");
    await expect(page.locator(".banner-count")).toHaveText("対応待ち 2");

    // every seeded job status is on a card
    await expect(page.locator(".card")).toHaveCount(6);
    await expect(page.locator(".badge", { hasText: "確認待ち" })).toBeVisible();
    await expect(page.locator(".badge", { hasText: "失敗" })).toBeVisible();
  });

  test("printing header shows a MEASURED percent + ETA from live status", async ({ page }) => {
    await page.goto("/");
    // fake harness status = 42% / 73min remaining → client labels it 実測
    await expect(page.locator(".printing .pct")).toContainText("実測");
    await expect(page.locator(".printing .pct")).toContainText("42%");
    await expect(page.locator(".printing .eta-clock")).toContainText("ETA");
  });

  test("polls /api/printer/status for live updates", async ({ page }) => {
    const hit = page.waitForResponse((r) => r.url().includes("/api/printer/status") && r.ok());
    await page.goto("/");
    const res = await hit;
    const body = await res.json();
    expect(body.printing).toBe(true);
    expect(body.remaining_min).toBe(73);
  });

  test("opens the SSE stream for live refresh", async ({ page }) => {
    const sse = page.waitForResponse((r) => r.url().includes("/events"));
    await page.goto("/");
    const res = await sse;
    expect(res.headers()["content-type"]).toContain("text/event-stream");
  });

  test("resolving a 対応待ち item drops the count via htmx swap", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".banner-count")).toHaveText("対応待ち 2");
    await page.locator(".pending .act", { hasText: "解決" }).first().click();
    await expect(page.locator(".banner-count")).toHaveText("対応待ち 1");
  });
});
