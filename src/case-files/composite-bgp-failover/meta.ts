import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-bgp-failover",
  slug: "composite-bgp-failover",
  title: "Composite: The Backup Path That Never Activated",
  track: "case-files",
  order: 58,
  difficulty: 4,
  minutes: 22,
  prerequisites: ["cloud-networking-bgp"],
  tags: ["BGP", "failover", "local preference", "AS path", "health"],
  productionQuestion:
    "The primary link fails and the backup stays idle. What attribute kept it unused?",
  learningDelta:
    "BGP failover depends on path attributes and health signals; an advertised backup is not a selected backup",
  objectives: [
    "Separate control-plane session state from data-plane forwarding health.",
    "Explain how local preference and AS path influence best-path selection.",
    "Perform a controlled failover when the primary path blackholes but its session stays up.",
    "Design liveness checks and drills that prove the backup path can carry traffic.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
