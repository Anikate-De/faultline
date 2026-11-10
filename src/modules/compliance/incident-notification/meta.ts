import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "compliance-incident-notification",
  slug: "incident-notification",
  title: "Incident Notification Timelines",
  track: "compliance",
  order: 19,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["reliability-legal"],
  tags: ["notification", "deadline", "breach", "legal", "jurisdiction"],
  productionQuestion:
    "A breach is suspected at 02:00. When does the notification clock start?",
  learningDelta:
    "Notification deadlines vary by regulation and jurisdiction; legal must be engaged as soon as a reportable incident is suspected",
  objectives: [
    "Explain when a notification clock starts and why a completed investigation is not required first.",
    "Select the applicable deadline from the regime, recipient, and contract instead of assuming a universal value.",
    "Compare a 24-hour contractual window, the GDPR 72-hour timeline, and a 60-day outer limit.",
    "Design a notification record that states what is known, what is still being assessed, and when the decision was made.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
