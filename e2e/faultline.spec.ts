import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const modulePath = "/modules/hot-key-sharding";

test("home loads and navigates to a track", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Break the system");
  await page.getByRole("link", { name: "All tracks" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tracks");
  await page.getByRole("link", { name: /Caching/ }).first().click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Caching");
  await expect(page.getByText("Hot Key Sharding", { exact: false }).first()).toBeVisible();
});

test("search finds the authored demo", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Control+KeyK");
  const dialog = page.getByRole("dialog", { name: "Search Faultline" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox").fill("hot key");
  await expect(dialog.getByRole("option").first()).toContainText("Hot Key Sharding");
  await dialog.getByRole("option").first().click();
  await expect(page).toHaveURL(/\/modules\/hot-key-sharding/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Hot Key Sharding");
});

test("module renders, a slider changes the model, and failure is obvious", async ({ page }) => {
  await page.goto(modulePath);
  const sim = page.locator("[data-sim-ready]");
  await expect(sim).toBeVisible();
  const hotCpu = sim.getByText("Hot shard CPU").first();
  await expect(hotCpu).toBeVisible();

  const slider = sim.getByRole("slider", { name: "Hot key share" });
  await slider.fill("55");
  await expect(sim).toHaveAttribute("data-incident", "crit");
  await expect(sim.getByText("Hot shard CPU crossed the critical threshold").first()).toBeVisible();
  await expect(sim.getByText("Check first").first()).toBeVisible();

  await sim.getByRole("button", { name: "Recovery", exact: true }).click();
  await expect(sim).toHaveAttribute("data-incident", "ok");
  await expect(sim.getByText("Healthy. No threshold is crossed.")).toBeVisible();
});

test("interview answer is hidden until revealed", async ({ page }) => {
  await page.goto(`${modulePath}#interview`);
  const section = page.locator("#interview");
  await expect(section).toBeVisible();
  const answer = "I would split the signal by shard and by key.";
  await expect(section.getByText(answer)).toHaveCount(0);
  await section.getByRole("button", { name: /Reveal/ }).first().click();
  await expect(section.getByText(answer, { exact: false })).toBeVisible();
});

test("guided experiment hides the explanation and runs to result", async ({ page }) => {
  await page.goto(modulePath);
  const experiment = page.locator("#experiments section").first();
  await experiment.scrollIntoViewIfNeeded();
  await experiment.getByRole("radio").first().click();
  await experiment.getByRole("button", { name: /^Run 20s/ }).click();
  await experiment.getByRole("button", { name: "Skip to result" }).click();
  await expect(experiment.getByText("Why the result happened")).toBeVisible();
  await expect(experiment.getByText("A hot key is a partitioning problem.")).toHaveCount(0);
  await experiment.getByRole("button", { name: /Reveal/ }).click();
  await expect(experiment.getByText("A hot key is a partitioning problem.", { exact: false })).toBeVisible();
});

test("focus mode opens, traps focus, and closes with Escape", async ({ page }) => {
  await page.goto(modulePath);
  const sim = page.locator("[data-sim-ready]");
  await sim.getByRole("button", { name: "Open focus mode" }).click();
  const dialog = page.getByRole("dialog", { name: /focus mode/i });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close focus mode" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("completion can be undone and persists across reload", async ({ page }) => {
  await page.goto(modulePath);
  await page.getByRole("button", { name: "Mark complete" }).click();
  await expect(page.getByRole("button", { name: "Undo mark complete" })).toBeVisible();
  await page.getByRole("button", { name: "Undo mark complete" }).click();
  await expect(page.getByRole("button", { name: "Mark complete" })).toBeVisible();
  await page.getByRole("button", { name: "Mark complete" }).click();
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("button", { name: "Undo mark complete" })).toBeVisible();
});

test("all modules path increases levels and marks case files as milestones", async ({ page }) => {
  await page.goto("/curriculum");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("All modules");
  await expect(page.getByText("Milestone", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Level 1 · Intro").first()).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("mobile layout has no horizontal scrolling", async ({ page }) => {
  for (const route of ["/", "/tracks/caching", "/curriculum", modulePath, "/case-files", "/glossary", "/progress", "/_lab"]) {
    await page.goto(route);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `overflow on ${route}`).toBeLessThanOrEqual(1);
  }
});

test("reduced motion keeps the failure state understandable", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(modulePath);
  const sim = page.locator("[data-sim-ready]");
  await sim.getByRole("button", { name: "Hot key", exact: true }).click();
  await expect(sim).toHaveAttribute("data-incident", "crit");
  await expect(sim.getByText("Hot shard CPU").first()).toBeVisible();
  await expect(sim.getByText("Failing").first()).toBeVisible();
});

test("404 is helpful and not blank", async ({ page }) => {
  await page.goto("/this-route-does-not-exist");
  await expect(page.getByText("That route is not here")).toBeVisible();
  await expect(page.getByRole("link", { name: "Tracks" })).toBeVisible();
});

test("desktop layout shows the sticky simulator", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(modulePath);
  await expect(page.locator("[data-sim-ready]")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

const exemplarSlugs = [
  "cache-stampede",
  "alb-connection-limit",
  "route-tables",
  "hot-partition",
  "scheduled-scaling-race",
  "adding-readers",
  "canary-metric-gate",
  "cross-region-rpo",
  "retry-storm",
  "datadog-tags",
];

for (const slug of exemplarSlugs) {
  test(`exemplar ${slug} renders healthy without overflow`, async ({ page }) => {
    await page.goto(`/modules/${slug}`);
    const sim = page.locator("[data-sim-ready]");
    await expect(sim).toBeVisible();
    await expect(sim).toHaveAttribute("data-incident", "ok");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
}

test("interview mode hides the experiment observe list until reveal", async ({ page }) => {
  await page.goto("/modules/cache-stampede");
  await page.getByRole("switch").click();
  const experiment = page.locator("#experiments section").first();
  await experiment.scrollIntoViewIfNeeded();
  await experiment.getByRole("radio").first().click();
  await experiment.getByRole("button", { name: /^Run 20s/ }).click();
  await experiment.getByRole("button", { name: "Skip to result" }).click();
  await expect(experiment.getByRole("button", { name: "Reveal prediction result" })).toBeVisible();
  await expect(experiment.getByText("Observe", { exact: true })).toHaveCount(0);
  await experiment.getByRole("button", { name: "Reveal prediction result" }).click();
  await expect(experiment.getByText("Observe", { exact: true })).toBeVisible();
});


const authoredModules = (
  JSON.parse(readFileSync(new URL("../src/generated/search-index.json", import.meta.url), "utf8")) as {
    entries: { slug: string }[];
  }
).entries;

test("all authored modules render healthy without overflow", async ({ page }) => {
  test.setTimeout(600_000);
  for (const { slug } of authoredModules) {
    await page.goto(`/modules/${slug}`);
    const sim = page.locator("[data-sim-ready]");
    await expect(sim, slug).toBeVisible({ timeout: 15_000 });
    await expect(sim, slug).toHaveAttribute("data-incident", "ok");
    const pageOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(pageOverflow, `${slug} page overflow`).toBeLessThanOrEqual(1);
    const simOverflow = await sim.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(simOverflow, `${slug} simulator overflow`).toBeLessThanOrEqual(1);
  }
});


const authoredCaseFiles = (
  JSON.parse(readFileSync(new URL("../src/generated/module-manifest.json", import.meta.url), "utf8")) as {
    modules: { slug: string; track: string }[];
  }
).modules.filter((module) => module.track === "case-files");

test("all authored case files render without overflow", async ({ page }) => {
  test.setTimeout(300_000);
  for (const { slug } of authoredCaseFiles) {
    await page.goto(`/case-files/${slug}`);
    await expect(page.locator("[data-case-file-ready]"), slug).toBeVisible({ timeout: 15_000 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${slug} page overflow`).toBeLessThanOrEqual(1);
  }
});
