import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-k8s-upgrade",
  slug: "composite-k8s-upgrade",
  title: "Composite: The Upgrade That Broke Ingress",
  track: "case-files",
  order: 64,
  difficulty: 4,
  minutes: 22,
  prerequisites: ["kubernetes-upgrades", "kubernetes-ingress"],
  tags: ["Kubernetes", "upgrade", "skew", "drain", "ingress"],
  productionQuestion:
    "The control plane upgrade succeeds but ingress returns 503 after nodes drain. What was missed?",
  learningDelta:
    "Upgrades need version-skew checks, API compatibility, PDBs, and capacity during drain; control-plane success is not workload success",
  objectives: [
    "Separate component version skew from API and workload compatibility.",
    "Plan node drains around disruption budgets and replacement capacity.",
    "Diagnose an ingress outage by checking controller compatibility before adding replicas.",
    "Stage an upgrade so a failed add-on does not remove all serving capacity.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
