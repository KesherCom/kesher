import { defineConfig } from "@playwright/test";
// @ts-ignore -- plain ESM helper shared with lab.mjs
import { listFromEnv, profileURL, launchOptions, contextOptions } from "./lib/lab.mjs";

// Test matrix = browsers × network profiles, both selectable via env:
//   LAB_BROWSERS=chromium,firefox,webkit   (also: chrome, msedge = installed browsers)
//   LAB_PROFILES=lan,wifi,wan,worst
const browsers: string[] = listFromEnv("LAB_BROWSERS", ["chromium", "firefox", "webkit"]);
const profiles: string[] = listFromEnv("LAB_PROFILES", ["lan", "wifi", "wan", "worst"]);

const projects = browsers.flatMap((browser) =>
  profiles.map((profile) => {
    const { type, options } = launchOptions(browser, { fakeMic: true, headless: !process.env.LAB_HEADED });
    return {
      name: `${browser}@${profile}`,
      metadata: { browser, profile },
      use: {
        browserName: type as "chromium" | "firefox" | "webkit",
        baseURL: profileURL(profile),
        channel: options.channel,
        launchOptions: { args: options.args, firefoxUserPrefs: options.firefoxUserPrefs },
        ...contextOptions(type),
      },
    };
  }),
);

export default defineConfig({
  testDir: "./tests",
  // All tests share the lab instances and talk on the same party line, so
  // they run one after another to keep the audio measurements clean.
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  retries: process.env.CI ? 1 : 0,
  outputDir: "./test-results",
  reporter: [["list"], ["./lib/audio-reporter.mjs"], ["html", { open: "never", outputFolder: "./playwright-report" }]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects,
});
