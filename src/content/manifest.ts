import data from "@/generated/module-index.json";
import type { ModuleMeta, TrackId } from "./types";

export interface ManifestModule {
  id: string;
  slug: string;
  track: TrackId;
  order: number;
  title: string;
  purpose: string;
  productionQuestion: string;
  learningDelta: string;
  concepts: string[];
  prerequisites: string[];
  caseFile: string | null;
  difficulty: 1 | 2 | 3 | 4;
  minutes: number;
  status: "planned" | "approved" | "authored" | "reviewed" | "cut";
}

export const MANIFEST = data.modules as ManifestModule[];
export const MODULE_BY_ID = new Map(MANIFEST.map((m) => [m.id, m]));
export const MODULE_BY_SLUG = new Map(MANIFEST.map((m) => [m.slug, m]));

export const CORE_MODULES = MANIFEST.filter((m) => m.track !== "case-files");
export const CASE_FILES = MANIFEST.filter((m) => m.track === "case-files");

export function modulesForTrack(track: TrackId): ManifestModule[] {
  return MANIFEST.filter((m) => m.track === track).sort((a, b) => a.order - b.order);
}

export function manifestCounts(): Record<string, number> {
  return MANIFEST.reduce<Record<string, number>>((acc, m) => {
    acc[m.track] = (acc[m.track] ?? 0) + 1;
    return acc;
  }, {});
}

export function manifestToMeta(m: ManifestModule): ModuleMeta {
  return {
    id: m.id,
    slug: m.slug,
    title: m.title,
    track: m.track,
    order: m.order,
    difficulty: m.difficulty,
    minutes: m.minutes,
    prerequisites: m.prerequisites,
    tags: m.concepts,
    productionQuestion: m.productionQuestion,
    learningDelta: m.learningDelta,
    objectives: m.concepts.slice(0, 4),
    interviewQuestions: 3,
    hasSim: true,
    caseStudy: m.track === "case-files",
    status: "draft",
    lastReviewed: "2026-11-10",
  };
}

export function caseFileKind(m: ManifestModule): "real" | "composite" {
  return m.caseFile?.startsWith("Composite") ? "composite" : "real";
}
