import type { Module, ModuleMeta } from "@/content/types";

const metaModules = import.meta.glob("/src/modules/**/meta.ts", { eager: true }) as Record<
  string,
  { meta: ModuleMeta }
>;
const contentModules = import.meta.glob("/src/modules/**/module.ts") as Record<
  string,
  () => Promise<{ module: Module }>
>;

export const AUTHORED_METAS: ModuleMeta[] = Object.values(metaModules)
  .map((mod) => mod.meta)
  .filter((meta) => meta.status !== "draft" || true)
  .sort((a, b) => a.track.localeCompare(b.track) || a.order - b.order);

export const AUTHORED_BY_SLUG = new Map(AUTHORED_METAS.map((meta) => [meta.slug, meta]));
export const AUTHORED_BY_ID = new Map(AUTHORED_METAS.map((meta) => [meta.id, meta]));
export const AUTHORED_BY_TRACK = AUTHORED_METAS.reduce<Record<string, ModuleMeta[]>>((acc, meta) => {
  (acc[meta.track] ??= []).push(meta);
  return acc;
}, {});

export function isAuthored(slug: string): boolean {
  return AUTHORED_BY_SLUG.has(slug);
}

export async function loadModule(slug: string): Promise<Module> {
  const meta = AUTHORED_BY_SLUG.get(slug);
  if (!meta) throw new Error(`Module not found: ${slug}`);
  const path = `/src/modules/${meta.track}/${meta.slug}/module.ts`;
  const loader = contentModules[path];
  if (!loader) throw new Error(`Module content missing: ${path}`);
  const mod = await loader();
  return mod.module;
}

export function authoredCountForTrack(track: string): number {
  return AUTHORED_BY_TRACK[track]?.length ?? 0;
}
