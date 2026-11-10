import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "foundations-failure-domains",
  slug: "failure-domains",
  title: "Failure Domains: Blast Radius by Design",
  track: "foundations",
  order: 32,
  difficulty: 2,
  minutes: 18,
  prerequisites: ["foundations-capacity-headroom"],
  tags: ["blast radius", "failure domain", "correlation", "zonal isolation", "dependency graph"],
  productionQuestion:
    "A single rack failure took down the service despite three AZs; what was correlated?",
  learningDelta:
    "Independent failure domains require independent power, network, deployment, and dependency paths, not just AZ labels",
  objectives: [
    "Distinguish an availability zone from an independent failure domain.",
    "Find correlated dependencies that defeat zonal redundancy.",
    "Estimate blast radius from domain scope and replication.",
    "Challenge a redundancy claim with a failure test that crosses domain boundaries.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
