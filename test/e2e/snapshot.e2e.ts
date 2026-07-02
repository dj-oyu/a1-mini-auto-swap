import { test, expect } from "./fixtures";

test.describe("camera snapshot", () => {
  test("正常系: opening the camera modal shows the snapshot; 更新 reloads it", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "カメラ" }).click();

    const modal = page.locator("#modal .modal-box");
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("カメラ");

    // the harness serves a placeholder frame → the img loads (200), stays shown
    const img = modal.locator(".snapshot");
    await expect(img).toBeVisible();
    const res = await page.request.get("/api/printer/snapshot");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("image/png");

    // 更新 swaps in a cache-busted src
    await modal.getByRole("button", { name: "更新" }).click();
    await expect(img).toHaveAttribute("src", /\/api\/printer\/snapshot\?t=\d+/);

    await modal.getByRole("button", { name: "閉じる" }).click();
    await expect(page.locator("#modal .modal-box")).toHaveCount(0);
  });
});
