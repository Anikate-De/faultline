import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-k8s-dns",
  slug: "composite-k8s-dns",
  title: "Composite: The DNS Timeout Under Load",
  track: "case-files",
  order: 63,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["kubernetes-dns"],
  tags: ["Kubernetes", "DNS", "CoreDNS", "ndots", "service discovery"],
  productionQuestion:
    "A service name times out under load while direct pod IPs work. What is the first split?",
  learningDelta:
    "DNS resolution and service routing are separate layers; ndots, CoreDNS capacity, and search paths can look like application latency",
  objectives: [
    "Split a service-name failure into resolution, routing, and application layers.",
    "Read a pod resolver configuration and explain how ndots changes query volume.",
    "Recognize DNS query amplification as a load-dependent failure mode.",
    "Choose a fix that reduces query volume as well as adding DNS capacity.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
