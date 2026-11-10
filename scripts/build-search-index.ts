import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

interface MetaModule {
  meta: {
    id: string;
    slug: string;
    title: string;
    track: string;
    tags: string[];
    productionQuestion: string;
    learningDelta: string;
    objectives: string[];
    minutes: number;
    difficulty: number;
    status: string;
  };
}

const root = join(process.cwd(), "src/modules");
const entries: unknown[] = [];

function walk(dir: string): void {
  for (const name of readdirSync(dir)) {
    if (name.startsWith("_")) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path);
      continue;
    }
    if (name !== "meta.ts") continue;
    entries.push(path);
  }
}

if (readdirSync(root, { withFileTypes: true }).length > 0) walk(root);

const built: Record<string, unknown>[] = [];
for (const entry of entries as string[]) {
  const mod = (await import(pathToFileURL(entry).href)) as MetaModule;
  const meta = mod.meta;
  if (!meta || meta.status === "draft") continue;
  built.push({
    id: meta.id,
    slug: meta.slug,
    title: meta.title,
    track: meta.track,
    tags: meta.tags,
    productionQuestion: meta.productionQuestion,
    learningDelta: meta.learningDelta,
    objectives: meta.objectives,
    minutes: meta.minutes,
    difficulty: meta.difficulty,
  });
}

built.sort((a, b) => String(a.title).localeCompare(String(b.title)));
writeFileSync(
  join(process.cwd(), "src/generated/search-index.json"),
  JSON.stringify({ version: 1, entries: built }, null, 2) + "\n",
);
console.log(`Search index: ${built.length} authored modules`);
