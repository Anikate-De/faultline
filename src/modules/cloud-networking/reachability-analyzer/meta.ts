import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "cloud-networking-reachability-analyzer",
  slug: "reachability-analyzer",
  title: "Reachability Analyzer",
  track: "cloud-networking",
  order: 29,
  difficulty: 2,
  minutes: 14,
  prerequisites: ["cloud-networking-route-tables"],
  tags: ["Reachability Analyzer", "path", "configuration", "blocking component", "test"],
  productionQuestion:
    "You need to know whether a new route will work. Can you test without sending traffic?",
  learningDelta:
    "Reachability Analyzer evaluates configuration paths and returns the blocking component; it does not prove live traffic behavior",
  objectives: [
    "Read a Reachability Analyzer result as a configuration path, not a live traffic test.",
    "Identify the blocking component by evaluation order: route, network ACL, security group.",
    "Distinguish an unreachable configuration from a reachable configuration with a failing application.",
    "Use the analyzer before a production change and know what still needs a packet test.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
