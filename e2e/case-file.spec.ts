import { expect, test } from "@playwright/test";

const exemplar = "/case-files/composite-retry-storm";

test("composite case file loads with labeled scenario, timeline, and sources", async ({ page }) => {
  await page.goto(exemplar);
  await expect(page.locator("[data-case-file-ready]")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("The Retry Storm That Outlived the Failure");
  await expect(page.getByText("Composite scenario — not a real incident.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sources" })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("composite decision reveals a consequence and a hidden debrief on demand", async ({ page }) => {
  await page.goto(exemplar);
  const group = page.getByRole("radiogroup").first();
  await expect(group).toBeVisible();
  await group.getByRole("radio").first().click();
  await expect(page.getByText("Consequence.").first()).toBeVisible();
  const debrief = page.getByRole("button", { name: "Reveal" }).first();
  await debrief.click();
  await expect(page.getByText("Reducing offered load is the first move", { exact: false })).toBeVisible();
});

test("public case file loads with verified sources", async ({ page }) => {
  await page.goto("/case-files/github-2018");
  await expect(page.locator("[data-case-file-ready]")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("GitHub 2018");
  await expect(page.getByText("Public incident", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sources" })).toBeVisible();
});
