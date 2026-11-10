import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-facebook-bgp-2021",
  slug: "facebook-bgp-2021",
  title: "Facebook 2021: BGP Withdrawal and the DNS Death Spiral",
  track: "case-files",
  order: 9,
  difficulty: 4,
  minutes: 26,
  prerequisites: ["cloud-networking-bgp"],
  tags: ["BGP", "DNS", "withdrawal", "out-of-band", "recovery"],
  productionQuestion:
    "The network withdraws its own routes and the recovery tools depend on the network. How do you recover?",
  learningDelta:
    "Out-of-band access and independent recovery paths are mandatory when the failure removes the management plane",
  objectives: [
    "Trace how a backbone misconfiguration led to BGP withdrawal and DNS unreachability.",
    "Explain why normal and out-of-band access failed together.",
    "Choose a restoration sequence that avoids a traffic and power surge.",
    "Design a recovery path that does not share fate with the failed network.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
