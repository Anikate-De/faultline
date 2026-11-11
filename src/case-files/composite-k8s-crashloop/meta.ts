import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-k8s-crashloop",
  slug: "composite-k8s-crashloop",
  title: "Composite: The CrashLoop That Passed Readiness",
  track: "case-files",
  order: 61,
  difficulty: 3,
  minutes: 20,
  prerequisites: ["kubernetes-probes"],
  tags: ["Kubernetes", "readiness", "liveness", "crashloop", "probes"],
  productionQuestion:
    "A new pod restarts every two minutes but readiness stays green until traffic arrives. What is wrong?",
  learningDelta:
    "Liveness and readiness test different things; a probe that only checks the process can pass while the request path is broken",
  objectives: [
    "Separate a readiness signal from a liveness restart decision.",
    "Explain why a TCP readiness check can pass before an application can serve requests.",
    "Choose a startup, readiness, and liveness probe contract that matches each signal's job.",
    "Recognize that adding replicas can multiply cold-start failures instead of fixing them.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
