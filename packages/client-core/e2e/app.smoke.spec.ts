import { expect, test } from "@playwright/test";

test("shows login screen and primary controls", async ({ page }) => {
  await page.route("**/api/public-bootstrap", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        roles: [{ id: "op", name: "Operator" }],
        rooms: [],
        broadcastGroups: [],
      }),
    });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "kesher - Live Production Intercom" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Join Intercom" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Show admin" })).toBeVisible();
});
