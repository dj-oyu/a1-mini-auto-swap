import { test, expect } from "./fixtures";

// FTPS upload-progress indicator (spec: upload progress indicator). The dev
// harness has no real printer/FTPS transfer, so POST /__dev/upload-progress
// injects deterministic `upload_progress` SSE frames (mirrors /__dev/progress
// for the printing header) — enough to exercise the browser-side wiring.
test.describe("FTPS upload progress indicator", () => {
  test("正常系: injected upload_progress frames drive the /verify Stage 5 bar to completion", async ({
    page,
    request,
  }) => {
    await page.goto("/verify");

    const live = page.locator("#verifyUploadLive");
    await expect(live).toBeHidden();

    await request.post(
      "/__dev/upload-progress?context=dry-rehearsal&bytes_sent=25000&total_bytes=100000",
    );
    await expect(live).toBeVisible();
    await expect(live.locator("[data-upload-msg]")).toContainText("アップロード中 25%");
    await expect(live.locator(".prog-bar")).toHaveAttribute("style", /width:\s*25%/);

    await request.post(
      "/__dev/upload-progress?context=dry-rehearsal&bytes_sent=100000&total_bytes=100000",
    );
    await expect(live.locator("[data-upload-msg]")).toContainText("送信完了、プリンター応答待ち");
    await expect(live.locator(".prog-bar")).toHaveAttribute("style", /width:\s*100%/);
  });

  test("正常系: a job- context upload shows a header chip on the dashboard and hides on completion", async ({
    page,
    request,
  }) => {
    await page.goto("/");

    const chip = page.locator("#uploadChip");
    await expect(chip).toBeHidden();

    await request.post("/__dev/upload-progress?context=job-1&bytes_sent=50&total_bytes=200");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("25%");

    await request.post("/__dev/upload-progress?context=job-1&bytes_sent=200&total_bytes=200");
    await expect(chip).toBeHidden();
  });
});
