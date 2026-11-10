import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mesh-mtls",
  slug: "mtls",
  title: "mTLS in the Mesh",
  track: "mesh",
  order: 5,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["mesh-kuma-control-plane"],
  tags: ["mTLS", "certificate", "identity", "permissive", "strict"],
  productionQuestion: "A service accepts plaintext from inside the mesh. What policy prevents it?",
  learningDelta:
    "mTLS authenticates both sides with certificates; permissive mode allows plaintext and hides misconfiguration",
  objectives: [
    "Distinguish authenticated identity from encrypted transport in a service mesh.",
    "Explain how strict and permissive modes change what an inbound proxy accepts.",
    "Read a mesh dashboard that looks healthy while plaintext traffic is admitted.",
    "Choose a migration path from permissive to strict without breaking callers.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
