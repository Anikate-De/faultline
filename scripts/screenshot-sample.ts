import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const base = process.env.APP_URL ?? "http://127.0.0.1:5173";
const root = process.cwd();
const outDir = join(root, "artifacts/screenshots");
mkdirSync(outDir, { recursive: true });

const viewports = [
  { name: "360", width: 360, height: 800 },
  { name: "390", width: 390, height: 844 },
  { name: "768", width: 768, height: 1024 },
  { name: "1440", width: 1440, height: 900 },
];

const browser = await chromium.launch({ channel: "chrome", headless: true });
for (const viewport of viewports) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto(base, { waitUntil: "networkidle" });
  await page.screenshot({ path: join(outDir, `home-${viewport.name}.png`), fullPage: true });

  await page.goto(`${base}/modules/hot-key-sharding`, { waitUntil: "networkidle" });
  await page.locator("[data-sim-ready]").scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(outDir, `module-${viewport.name}-healthy.png`), fullPage: true });

  await page.getByRole("button", { name: "Hot key", exact: true }).click();
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    const sim = document.querySelector("[data-sim-ready]");
    if (sim) window.scrollTo(0, sim.getBoundingClientRect().top + window.scrollY - 70);
  });
  await page.screenshot({ path: join(outDir, `module-${viewport.name}-failure.png`) });

  await page.getByRole("button", { name: "Open focus mode" }).click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(outDir, `module-${viewport.name}-focus.png`) });
  await page.keyboard.press("Escape");

  const light = page.getByRole("button", { name: "Switch to light theme" });
  if (await light.count()) {
    await light.click();
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(outDir, `module-${viewport.name}-light.png`) });
    await page.getByRole("button", { name: "Switch to dark theme" }).click();
  }

  await page.goto(`${base}/_lab`, { waitUntil: "networkidle" });
  await page.screenshot({ path: join(outDir, `lab-${viewport.name}.png`), fullPage: true });

  await page.goto(`${base}/curriculum`, { waitUntil: "networkidle" });
  await page.screenshot({ path: join(outDir, `curriculum-${viewport.name}.png`), fullPage: true });

  if (viewport.name === "390") {
    await page.goto(base, { waitUntil: "networkidle" });
    await page.keyboard.press("Control+KeyK");
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(outDir, "search-390.png") });
  }
  await context.close();
}
console.log(`Screenshots written to ${outDir}`);
await browser.close();
