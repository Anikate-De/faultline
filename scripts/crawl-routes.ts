import { chromium } from "@playwright/test";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const base = process.env.APP_URL ?? "http://127.0.0.1:5173";
const root = process.cwd();
const modulesRoot = join(root, "src/modules");

function authoredSlugs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith("_") || name === "registry.ts") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...authoredSlugs(path));
  }
  const meta = join(dir, "meta.ts");
  if (readdirSync(dir).includes("meta.ts") && statSync(meta).isFile()) {
    const slug = dir.split("/").at(-1);
    if (slug) out.push(slug);
  }
  return out;
}

const slugs = authoredSlugs(modulesRoot);
const routes = [
  "/",
  "/tracks",
  "/tracks/caching",
  "/tracks/kubernetes",
  "/curriculum",
  "/case-files",
  "/review",
  "/glossary",
  "/progress",
  "/about",
  "/_lab",
  ...slugs.map((slug) => `/modules/${slug}`),
];

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const report: { route: string; ok: boolean; status: number | null; overflow: number; errors: string[]; moduleReady?: boolean }[] = [];

for (const route of routes) {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  const response = await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(150);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  const moduleReady = route.startsWith("/modules/")
    ? (await page.locator("[data-module-ready]").count()) > 0
    : undefined;
  const ok = Boolean(response?.ok()) && overflow <= 1 && errors.length === 0 && moduleReady !== false;
  report.push({ route, ok, status: response?.status() ?? null, overflow, errors, moduleReady });
  await page.close();
}

mkdirSync(join(root, "artifacts"), { recursive: true });
writeFileSync(join(root, "artifacts/crawl-report.json"), JSON.stringify({ base, routes: report }, null, 2));
const failures = report.filter((item) => !item.ok);
for (const failure of failures) console.error(JSON.stringify(failure));
console.log(`Crawled ${report.length} routes; ${failures.length} failure(s).`);
await browser.close();
if (failures.length) process.exit(1);
