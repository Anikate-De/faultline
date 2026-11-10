import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-google-cloud-2019",
  slug: "google-cloud-2019",
  title: "Google Cloud 2019: A Network Policy Outage",
  track: "case-files",
  order: 17,
  difficulty: 4,
  minutes: 24,
  prerequisites: ["cloud-networking-route-tables"],
  tags: ["cloud networking", "control plane", "regional outage", "flow logs", "status"],
  productionQuestion:
    "Regional traffic fails while compute instances are healthy. How do you localize a network control-plane fault?",
  learningDelta:
    "Cloud network control-plane faults can isolate healthy workloads; flow logs, route state, and provider status localize the failure",
  objectives: [
    "Separate compute health from network reachability during a regional outage.",
    "Recognize a maintenance automation bug as a control-plane blast-radius failure.",
    "Use provider status and route state to avoid replacing healthy instances.",
    "Evaluate fail-static behavior as a recovery budget, not a guarantee.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
