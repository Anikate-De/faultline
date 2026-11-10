import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "cloud-networking-route-propagation",
  slug: "route-propagation",
  title: "Route Propagation",
  track: "cloud-networking",
  order: 9,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["cloud-networking-peering-vs-tgw"],
  tags: ["route propagation", "longest prefix", "BGP", "attachment", "asymmetry"],
  productionQuestion:
    "Two attachments advertise the same prefix. Which path does traffic take?",
  learningDelta:
    "Longest prefix wins; for equal prefixes, route origin and propagation rules decide, and asymmetric paths are common",
  objectives: [
    "Apply longest-prefix match before comparing route type or BGP attributes.",
    "Order a static route, a VPC-propagated route, and a VPN-propagated route for the same prefix.",
    "Explain how AS path length breaks a tie between routes from the same attachment type.",
    "Recognize an asymmetric return path and choose between route symmetry and inspection.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
