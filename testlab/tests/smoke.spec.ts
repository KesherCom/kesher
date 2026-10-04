import { expect, test } from "@playwright/test";
// @ts-ignore -- plain ESM helper
import { login, peerCaptureScript, audioStats } from "../lib/lab.mjs";

test.beforeEach(async ({ context }) => {
  await context.addInitScript(peerCaptureScript);
});

test("server is healthy and serves the UI", async ({ page, baseURL, request }) => {
  const health = await request.get(`${baseURL}/api/healthz`);
  expect(health.ok()).toBeTruthy();

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Join Intercom" })).toBeVisible();
  await expect(page.getByLabel("Role").locator("option[value='audio']")).toHaveCount(1);
});

test("login reaches the station view and opens the realtime connection", async ({ page, baseURL }, testInfo) => {
  const username = `smoke${testInfo.workerIndex}${Date.now() % 100000}`;
  await login(page, baseURL!, { username, role: "audio" });

  await expect(page.locator(".station-live-dot.connected")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Hold to talk" })).toBeVisible();
  await expect(page.locator("article.station-card", { hasText: "FOH" })).toBeVisible();

  const hasWebRTC = await page.evaluate(() => typeof RTCPeerConnection !== "undefined");
  test.skip(!hasWebRTC, "this browser build has no WebRTC (e.g. Playwright WebKit on Windows)");
  await expect
    .poll(async () => (await audioStats(page)).connected, { timeout: 20_000, message: "WebRTC peer should connect" })
    .toBeGreaterThan(0);
});
