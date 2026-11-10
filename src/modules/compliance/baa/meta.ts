import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "compliance-baa",
  slug: "baa",
  title: "Business Associate Agreements",
  track: "compliance",
  order: 3,
  difficulty: 2,
  minutes: 14,
  prerequisites: ["compliance-phi"],
  tags: ["BAA", "business associate", "vendor", "PHI", "contract"],
  productionQuestion:
    "You want to use a new observability vendor for a HIPAA workload. What must exist first?",
  learningDelta:
    "A BAA binds a vendor that handles PHI; without it, the vendor relationship is not compliant regardless of encryption",
  objectives: [
    "Decide when a vendor that touches a health-data workload is a business associate.",
    "Explain what a BAA does and does not prove about a vendor's security.",
    "Place a BAA gate in the data path instead of in a spreadsheet.",
    "Evaluate a vendor onboarding flow for PHI egress and subcontractor risk.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
