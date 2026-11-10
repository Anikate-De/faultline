import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mesh-kuma-control-plane",
  slug: "kuma-control-plane",
  title: "Kuma Control Plane",
  track: "mesh",
  order: 4,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["mesh-envoy-clusters"],
  tags: ["Kuma", "control plane", "policy", "selector", "mesh"],
  productionQuestion:
    "A policy applies to half the mesh and no one knows why. Where is the selector?",
  learningDelta:
    "Kuma's control plane distributes policies to selected data plane proxies; selectors, mesh scope, and versions decide where they apply",
  objectives: [
    "Separate control plane configuration from data plane traffic handling.",
    "Trace a Kuma policy from its selector to the data plane proxies that receive it.",
    "Diagnose a policy that overmatches, misses, or never reaches its intended workloads.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
