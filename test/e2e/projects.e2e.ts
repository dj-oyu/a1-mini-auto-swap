import { test, expect } from "./fixtures";

// Seeded projects: "Benchy Fleet" (strict), "Gridfinity Bins" (propagate).

test.describe("projects page", () => {
  test("正常系: navigate from the queue, see seeded projects + progress", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "プロジェクト" }).click();

    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.locator(".proj-card", { hasText: "Benchy Fleet" })).toBeVisible();
    await expect(page.locator(".proj-card", { hasText: "Gridfinity Bins" })).toBeVisible();
    // Benchy Fleet has 3 plates, 1 done (benchy_chimney success)
    await expect(page.locator(".proj-card", { hasText: "Benchy Fleet" })).toContainText("完了 1/3");
    // per-project completion clock is computed client-side (HH:MM)
    await expect(page.locator(".proj-card", { hasText: "Benchy Fleet" }).locator(".proj-eta")).toContainText(
      /完了予定 \d{2}:\d{2}/,
    );
  });

  test("正常系: toggling a project's policy persists via htmx", async ({ page }) => {
    await page.goto("/projects");
    const card = page.locator(".proj-card", { hasText: "Benchy Fleet" });
    await expect(card.locator("select")).toHaveValue("strict");

    await card.locator("select").selectOption("propagate");
    // fragment re-rendered by htmx; the new value sticks after the swap
    await expect(
      page.locator(".proj-card", { hasText: "Benchy Fleet" }).locator("select"),
    ).toHaveValue("propagate");
  });

  test("正常系: creating a project adds a card", async ({ page }) => {
    await page.goto("/projects");
    await expect(page.locator(".proj-card")).toHaveCount(2);

    await page.locator('.proj-new input[name="name"]').fill("Night Run");
    await page.locator('.proj-new select[name="policy"]').selectOption("propagate");
    await page.getByRole("button", { name: "作成" }).click();

    await expect(page.locator(".proj-card", { hasText: "Night Run" })).toBeVisible();
    await expect(page.locator(".proj-card")).toHaveCount(3);
  });

  test("異常系: an empty queue+projects reset shows the empty projects state", async ({ page, request }) => {
    await request.post("/__dev/reset?seed=0");
    await page.goto("/projects");
    await expect(page.locator(".empty")).toHaveText("プロジェクトがありません");
  });
});
