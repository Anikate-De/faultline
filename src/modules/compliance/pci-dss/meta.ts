import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "compliance-pci-dss",
  slug: "pci-dss",
  title: "PCI DSS Scope Reduction",
  track: "compliance",
  order: 12,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["compliance-data-classification"],
  tags: ["PCI DSS", "cardholder data", "scope", "tokenization", "segmentation"],
  productionQuestion:
    "The card-data environment includes the whole platform. How do you reduce scope?",
  learningDelta:
    "PCI scope follows cardholder data and connected systems; tokenization and segmentation shrink the audit boundary",
  objectives: [
    "Identify which systems store, process, transmit, or connect to cardholder data.",
    "Explain how tokenization removes primary account numbers from downstream systems.",
    "Evaluate segmentation as an enforced boundary rather than a diagram.",
    "Choose scope reductions and state their operational tradeoffs.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
