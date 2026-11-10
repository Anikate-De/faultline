import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-dns-cache",
  slug: "composite-dns-cache",
  title: "Composite: The DNS Cache That Outlived the Fix",
  track: "case-files",
  order: 51,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["traffic-dns-ttl-failover"],
  tags: ["DNS", "client cache", "runtime", "connection pool", "recovery"],
  productionQuestion: "The record is fixed but one language runtime keeps failing. Why?",
  learningDelta:
    "Runtime DNS caching and connection pools can outlive record changes; restarts or cache TTLs determine recovery",
  objectives: [
    "Separate authoritative DNS state from what a client process is actually using.",
    "Explain how runtime caches and pooled connections extend recovery time.",
    "Recover a cached client without disrupting healthy traffic.",
    "Design a cutover that accounts for per-runtime cache behavior.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
