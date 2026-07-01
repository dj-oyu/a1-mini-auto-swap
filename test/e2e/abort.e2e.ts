import { test, expect } from "./fixtures";

// Seeded: job 1 (benchy_hull) printing; job 2 (benchy_deck) queued next.

test.describe("abort a running print", () => {
  test("正常系: 中止 (two-step) → aborted, next plate auto-advances", async ({ page }) => {
    await page.goto("/");
    const hull = page.locator(".card", { hasText: "benchy_hull" });
    await expect(hull.locator(".badge")).toHaveText("印刷中");

    const abort = hull.getByRole("button", { name: "中止" });
    await abort.click(); // arms
    await expect(hull.getByRole("button", { name: "本当に中止？" })).toBeVisible();
    await hull.getByRole("button", { name: "本当に中止？" }).click(); // confirms

    // job 1 aborted; the dispatcher auto-advances → job 2 now printing
    await expect(page.locator(".card", { hasText: "benchy_hull" }).locator(".badge")).toHaveText("中止");
    await expect(page.locator(".card", { hasText: "benchy_deck" }).locator(".badge")).toHaveText(
      "印刷中",
    );
  });

  test("異常系: non-printing cards expose no 中止", async ({ page }) => {
    await page.goto("/");
    const queued = page.locator(".card", { hasText: "gridfinity_2x2" });
    await expect(queued.locator(".badge")).toHaveText("待機中");
    await expect(queued.getByRole("button", { name: "中止" })).toHaveCount(0);
  });
});
