import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "kubernetes-dns",
  slug: "dns",
  title: "Cluster DNS and Resolution",
  track: "kubernetes",
  order: 9,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["kubernetes-services-networking"],
  tags: ["CoreDNS", "ndots", "search path", "headless service", "DNS latency"],
  productionQuestion:
    "Calls to a Service name fail intermittently while pod IPs work. What do you check?",
  learningDelta:
    "CoreDNS, ndots, and search paths shape resolution; DNS failures look like application timeouts",
  objectives: [
    "Read resolv.conf and predict how ndots and search paths expand a lookup.",
    "Separate DNS query amplification from CoreDNS capacity and application latency.",
    "Explain why a headless Service returns endpoint addresses instead of a virtual IP.",
    "Choose a fix that reduces lookup volume without hiding a real CoreDNS failure.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
