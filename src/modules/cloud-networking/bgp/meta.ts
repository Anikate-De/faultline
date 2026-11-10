import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "cloud-networking-bgp",
  slug: "bgp",
  title: "BGP for Hybrid Networking",
  track: "cloud-networking",
  order: 19,
  difficulty: 4,
  minutes: 18,
  prerequisites: ["cloud-networking-direct-connect"],
  tags: ["BGP", "AS path", "local preference", "MED", "failover"],
  productionQuestion: "Two paths advertise the same prefix and traffic takes the slower one. Why?",
  learningDelta:
    "BGP selects paths by attributes such as local preference, AS path, and MED; failover depends on what changes",
  objectives: [
    "Apply the BGP best-path order to two competing paths with the same prefix.",
    "Explain why a higher local preference beats a shorter AS path and why MED is a weaker signal.",
    "Distinguish a control-plane failure from a data-plane failure that leaves BGP established.",
    "Design a failover test that proves the backup becomes selected, not just reachable.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
