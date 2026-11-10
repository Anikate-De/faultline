import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "capacity-cost-allocation",
  slug: "cost-allocation",
  title: "Cost Allocation",
  track: "capacity",
  order: 19,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["capacity-unit-economics"],
  tags: ["cost allocation", "tags", "shared cost", "ownership", "showback"],
  productionQuestion:
    "The bill is one number and no team owns it. How do you allocate cost?",
  learningDelta:
    "Cost allocation uses tags, accounts, and shared-cost splits; untagged resources and shared platforms need explicit rules",
  objectives: [
    "Separate direct, shared, and untagged spend in a monthly bill.",
    "Explain why tag coverage and shared-cost rules answer different questions.",
    "Diagnose an unowned cost line from allocation rules rather than from the total bill.",
    "Choose an allocation rule and defend its incentives.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
