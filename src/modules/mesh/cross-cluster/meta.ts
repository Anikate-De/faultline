import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mesh-cross-cluster",
  slug: "cross-cluster",
  title: "Cross-Cluster Mesh",
  track: "mesh",
  order: 16,
  difficulty: 4,
  minutes: 20,
  prerequisites: ["mesh-locality"],
  tags: ["cross-cluster", "remote service", "locality", "failover", "latency"],
  productionQuestion: "A failover sends all traffic to one cluster and latency rises. What does the mesh know?",
  learningDelta:
    "Cross-cluster mesh discovers remote services; locality and failover policy decide whether traffic stays local",
  objectives: [
    "Explain how a multi-zone control plane makes a remote service discoverable.",
    "Quantify how a failover shift changes local and remote cluster load.",
    "Distinguish remote reachability from remote capacity.",
    "Choose a failover share that fits the remote cluster's headroom.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
