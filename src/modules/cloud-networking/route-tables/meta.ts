import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "cloud-networking-route-tables",
  slug: "route-tables",
  title: "Route Table Blackholes",
  track: "cloud-networking",
  order: 3,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["cloud-networking-subnets"],
  tags: ["blackhole", "target", "route", "forwarding", "attachment"],
  productionQuestion:
    "The instance has a route to the destination but packets disappear. What does the route target do?",
  learningDelta:
    "A route can point to a blackhole or an attachment that is unavailable; route presence does not guarantee forwarding",
  objectives: [
    "Read a route table by destination, target, and state instead of assuming a matching route forwards traffic.",
    "Distinguish a blackhole target from a missing route, a saturated target, and a missing return path.",
    "Use route state, target attachment state, and both-direction checks to localize a silent drop.",
    "Decide when to restore a target, replace a route, or add capacity without widening the blast radius.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
