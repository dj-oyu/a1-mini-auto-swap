import { test, expect } from "./fixtures";

test.describe("camera modal", () => {
  test("正常系: opening the camera modal shows the live MJPEG stream", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "カメラ" }).click();

    const modal = page.locator("#modal .modal-box");
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("カメラ");
    await expect(modal).toContainText("ライブ"); // live label, no manual refresh

    // the img streams the relay endpoint (multipart/x-mixed-replace). We don't
    // fetch the stream here — it is intentionally endless — the <img> renders it.
    const img = modal.locator(".snapshot");
    await expect(img).toBeVisible();
    await expect(img).toHaveAttribute("src", "/api/printer/camera.mjpeg");

    // the one-off snapshot endpoint still works (webhook attachment / verify)
    const snap = await page.request.get("/api/printer/snapshot");
    expect(snap.status()).toBe(200);
    expect(snap.headers()["content-type"]).toContain("image/jpeg");

    // closing blanks the img src so the MJPEG connection is dropped
    await modal.getByRole("button", { name: "閉じる" }).click();
    await expect(page.locator("#modal .modal-box")).toHaveCount(0);
  });
});
