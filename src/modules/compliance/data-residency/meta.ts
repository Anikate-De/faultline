import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "compliance-data-residency",
  slug: "data-residency",
  title: "Data Residency",
  track: "compliance",
  order: 7,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["cloud-networking-cross-az-region"],
  tags: ["residency", "region", "processing", "support access", "telemetry"],
  productionQuestion:
    "A customer contract requires EU-only storage. Which services and logs cross the boundary?",
  learningDelta:
    "Residency covers storage, processing, support access, backups, and telemetry; a regional bucket does not make the whole path local",
  objectives: [
    "Distinguish a region, an availability zone, and a contractual residency boundary.",
    "Trace storage, processing, backups, telemetry, and support access across a regional path.",
    "Find the global service or control-plane path that a regional data store does not cover.",
    "Design enforcement and evidence for a residency commitment without treating it as a legal opinion.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
