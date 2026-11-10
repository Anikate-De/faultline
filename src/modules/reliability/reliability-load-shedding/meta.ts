import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "reliability-load-shedding",
  slug: "reliability-load-shedding",
  title: "Load Shedding in an Incident",
  track: "reliability",
  order: 16,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["foundations-load-shedding"],
  tags: ["load shedding", "critical path", "priority", "communication", "degradation"],
  productionQuestion:
    "The service is overloaded and every request is timing out. What do you shed first?",
  learningDelta:
    "Incident load shedding is a product decision made in advance: protect the critical path, drop low-value work, and communicate",
  objectives: [
    "Choose what to shed first using a pre-agreed ranking of request classes.",
    "Explain why protecting the critical path matters more than preserving total request count.",
    "Recognize the moment when shedding everything is the same failure as shedding nothing.",
    "Write the customer-facing message that accompanies a shedding decision.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
