import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-sidecar-cpu",
  slug: "composite-sidecar-cpu",
  title: "Composite: The Sidecar That Stole the CPU",
  track: "case-files",
  order: 55,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["mesh-sidecar-overhead"],
  tags: ["sidecar", "CPU", "throttling", "mesh", "limits"],
  productionQuestion:
    "Latency rises after enabling the mesh and the app container is throttled. What is the cause?",
  learningDelta:
    "Sidecars share task CPU; limits and requests must account for proxy overhead or the main container starves",
  objectives: [
    "Read CPU throttling per container rather than as a pod average.",
    "Explain how an unbudgeted sidecar changes scheduling and limits for the whole workload.",
    "Distinguish proxy throttling from application throttling when both produce latency.",
    "Size requests and limits so the proxy has capacity without consuming the app's headroom.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
