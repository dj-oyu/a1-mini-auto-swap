import { test, expect } from "./fixtures";

test.describe("build-plate low warning", () => {
  test("正常系: a stocker_low SSE event pops a toast", async ({ page, request }) => {
    await page.goto("/");
    await expect(page.locator("#toast")).toBeHidden();

    await request.post(
      "/__dev/notify?type=stocker_low&message=" +
        encodeURIComponent("最後のビルドプレートをベッドに載せました。補充してください"),
    );

    const toast = page.locator("#toast");
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("最後のビルドプレート");

    // click to dismiss
    await toast.click();
    await expect(toast).toBeHidden();
  });
});
