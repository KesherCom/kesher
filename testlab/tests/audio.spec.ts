import { expect, test, chromium, firefox, webkit, type Browser, type Page } from "@playwright/test";
// @ts-ignore -- plain ESM helper
import { login, setPartyLine, peerCaptureScript, audioStats, audioDelta, launchOptions, contextOptions } from "../lib/lab.mjs";

const MEASURE_SECONDS = Number(process.env.LAB_MEASURE_SECONDS || 6);

// Generous per-profile limits; the real numbers end up in the summary table.
const LIMITS: Record<string, { lossPct: number; concealedPct: number }> = {
  lan: { lossPct: 1, concealedPct: 5 },
  wifi: { lossPct: 4, concealedPct: 10 },
  wan: { lossPct: 6, concealedPct: 20 },
  worst: { lossPct: 20, concealedPct: 50 },
};

// Partner engine for the cross-browser test.
const PARTNER: Record<string, string> = { chromium: "firefox", firefox: "chromium", webkit: "chromium" };
const ENGINES = { chromium, firefox, webkit };

async function newUserPage(browser: Browser, engine: string): Promise<Page> {
  const context = await browser.newContext(contextOptions(engine));
  await context.addInitScript(peerCaptureScript);
  return context.newPage();
}

async function requireWebRTC(page: Page) {
  const ok = await page.evaluate(() => typeof RTCPeerConnection !== "undefined");
  test.skip(!ok, "this browser build has no WebRTC (e.g. Playwright WebKit on Windows)");
}

/** Talker holds PTT; returns the listener-side quality metrics. */
async function talkAndMeasure(talker: Page, listener: Page, profile: string) {
  // Setup over the emulated link takes longer on bad networks.
  const slow = profile === "worst" ? 3 : profile === "wan" ? 1.5 : 1;
  // Talker talks (but does not listen, avoiding self-monitoring); listener listens.
  await setPartyLine(talker, "FOH", { talk: true, listen: false });
  await setPartyLine(listener, "FOH", { talk: false, listen: true });
  for (const p of [talker, listener]) {
    await expect
      .poll(async () => (await audioStats(p)).connected, { timeout: 20_000 * slow, message: "WebRTC peer should connect" })
      .toBeGreaterThan(0);
  }

  const idleBefore = await audioStats(listener);
  const ptt = talker.getByRole("button", { name: "Hold to talk" });
  await ptt.hover();
  await talker.mouse.down();
  try {
    await expect(ptt).toHaveClass(/\bactive\b/);
    await expect
      .poll(async () => (await audioStats(listener)).inPackets - idleBefore.inPackets, {
        timeout: 15_000 * slow,
        message: "listener should start receiving audio after PTT",
      })
      .toBeGreaterThan(25);

    const before = await audioStats(listener);
    await listener.waitForTimeout(MEASURE_SECONDS * 1000);
    const after = await audioStats(listener);
    const talkerStats = await audioStats(talker);
    return { metrics: audioDelta(before, after, MEASURE_SECONDS), talkerOutPackets: talkerStats.outPackets };
  } finally {
    await talker.mouse.up();
  }
}

async function assertSilenceAfterRelease(listener: Page) {
  await listener.waitForTimeout(1500);
  const a = await audioStats(listener);
  await listener.waitForTimeout(2000);
  const b = await audioStats(listener);
  // The SFU may keep forwarding packets (the disabled track sends silence),
  // so judge by received signal energy where the browser reports it.
  const idle = audioDelta(a, b, 2);
  if (idle.audioEnergy != null) {
    expect.soft(idle.audioEnergy, "listener should hear silence after PTT release").toBeLessThan(0.001);
  }
}

function check(metrics: ReturnType<typeof audioDelta>, profile: string) {
  expect(metrics.packetsPerSecond, "audio packets per second").toBeGreaterThan(20);
  if (metrics.audioEnergy != null) {
    // Browsers that report totalAudioEnergy must see real signal (test tone).
    expect.soft(metrics.audioEnergy, "received audio should not be silent").toBeGreaterThan(0);
  }
  const limit = LIMITS[profile] ?? LIMITS.worst;
  expect.soft(metrics.lossPct, "packet loss %").toBeLessThanOrEqual(limit.lossPct);
  if (metrics.concealedPct != null) {
    expect.soft(metrics.concealedPct, "concealed (PLC) audio %").toBeLessThanOrEqual(limit.concealedPct);
  }
}

test.describe("party-line audio", () => {
  test("talker → listener in the same browser", async ({ browser, baseURL }, testInfo) => {
    const { browser: name, profile } = testInfo.project.metadata as { browser: string; profile: string };
    const engine = browser.browserType().name();
    const id = Date.now() % 100000;
    const talker = await newUserPage(browser, engine);
    const listener = await newUserPage(browser, engine);
    try {
      await login(talker, baseURL!, { username: `talk${id}`, role: "audio" });
      await requireWebRTC(talker);
      await login(listener, baseURL!, { username: `listen${id}`, role: "producer" });

      const { metrics } = await talkAndMeasure(talker, listener, profile);
      await testInfo.attach("audio-metrics", {
        contentType: "application/json",
        body: JSON.stringify({ talker: name, listener: name, profile, metrics }),
      });
      check(metrics, profile);
      await assertSilenceAfterRelease(listener);
    } finally {
      await talker.context().close();
      await listener.context().close();
    }
  });

  test("talker → listener across browser engines", async ({ browser, baseURL }, testInfo) => {
    const { browser: name, profile } = testInfo.project.metadata as { browser: string; profile: string };
    const engine = browser.browserType().name();
    const partnerName = process.env.LAB_CROSS_PARTNER || PARTNER[engine];
    test.skip(!partnerName, `no partner browser for ${engine}`);

    const { type: partnerEngine, options } = launchOptions(partnerName, { fakeMic: true, headless: !process.env.LAB_HEADED });
    let partner: Browser;
    try {
      partner = await ENGINES[partnerEngine as keyof typeof ENGINES].launch(options);
    } catch (err) {
      test.skip(true, `partner browser ${partnerName} not installed: ${String(err).split("\n")[0]}`);
      return;
    }
    const id = Date.now() % 100000;
    const talker = await newUserPage(browser, engine);
    const listener = await newUserPage(partner, partnerEngine);
    try {
      await login(talker, baseURL!, { username: `xtalk${id}`, role: "audio" });
      await requireWebRTC(talker);
      await login(listener, baseURL!, { username: `xlisten${id}`, role: "producer" });
      await requireWebRTC(listener);

      const { metrics } = await talkAndMeasure(talker, listener, profile);
      await testInfo.attach("audio-metrics", {
        contentType: "application/json",
        body: JSON.stringify({ talker: name, listener: partnerName, profile, metrics }),
      });
      check(metrics, profile);
    } finally {
      await talker.context().close();
      await partner.close();
    }
  });
});
