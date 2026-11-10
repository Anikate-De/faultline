import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dist = "dist";
const html = readFileSync(join(dist, "index.html"));
const manifest = JSON.parse(readFileSync("src/generated/module-manifest.json", "utf8"));
const routes = new Set([
  "/tracks",
  "/curriculum",
  "/case-files",
  "/review",
  "/glossary",
  "/progress",
  "/about",
  "/_lab",
]);

for (const module of manifest.modules) {
  routes.add(`/tracks/${module.track}`);
  routes.add(module.track === "case-files" ? `/case-files/${module.slug}` : `/modules/${module.slug}`);
}

for (const route of routes) {
  const dir = join(dist, route.replace(/^\//, ""));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), html);
}
writeFileSync(join(dist, "404.html"), html);
console.log(`Wrote ${routes.size} static routes and 404.html`);
