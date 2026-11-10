import type { CaseStudy, ModuleMeta } from "@/content/types";

const metaFiles = import.meta.glob("/src/case-files/*/meta.ts", { eager: true }) as Record<
  string,
  { meta: ModuleMeta }
>;
const caseFiles = import.meta.glob("/src/case-files/*/case.ts") as Record<
  string,
  () => Promise<{ caseStudy: CaseStudy }>
>;

export const AUTHORED_CASE_METAS: ModuleMeta[] = Object.values(metaFiles)
  .map((mod) => mod.meta)
  .sort((a, b) => a.order - b.order);

export const AUTHORED_CASE_BY_SLUG = new Map(AUTHORED_CASE_METAS.map((meta) => [meta.slug, meta]));
export const AUTHORED_CASE_BY_ID = new Map(AUTHORED_CASE_METAS.map((meta) => [meta.id, meta]));

export function hasAuthoredCase(slug: string): boolean {
  return AUTHORED_CASE_BY_SLUG.has(slug);
}

export interface LoadedCaseFile {
  meta: ModuleMeta;
  caseStudy: CaseStudy;
}

export async function loadCaseFile(slug: string): Promise<LoadedCaseFile> {
  const meta = AUTHORED_CASE_BY_SLUG.get(slug);
  if (!meta) throw new Error(`Case file not found: ${slug}`);
  const path = `/src/case-files/${meta.slug}/case.ts`;
  const loader = caseFiles[path];
  if (!loader) throw new Error(`Case file content missing: ${path}`);
  const { caseStudy } = await loader();
  return { meta, caseStudy };
}
