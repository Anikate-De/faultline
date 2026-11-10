import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-github-2020",
  slug: "github-2020",
  title: "GitHub 2020: DNS, TTLs, and the Recovery Window",
  track: "case-files",
  order: 11,
  difficulty: 3,
  minutes: 22,
  prerequisites: ["traffic-dns-ttl-failover"],
  tags: ["DNS", "TTL", "resolver", "cache", "rollback"],
  productionQuestion:
    "The DNS record is restored but users still fail for an hour. What controls the recovery window?",
  learningDelta:
    "DNS recovery is bounded by TTL, resolver behavior, and client caches; rollback does not imply immediate recovery",
  objectives: [
    "Separate the trigger from the dependency that blocked recovery.",
    "Explain why a broad redeploy amplified the failure.",
    "Describe how cached DNS state shaped the recovery path.",
    "Choose controls for DNS changes and image-registry dependencies.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
