import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "compliance-phi",
  slug: "phi",
  title: "PHI Handling",
  track: "compliance",
  order: 2,
  difficulty: 2,
  minutes: 14,
  prerequisites: ["compliance-hipaa"],
  tags: ["PHI", "identifier", "health data", "de-identification", "scope"],
  productionQuestion:
    "A log contains a diagnosis code and a patient identifier. Is that PHI?",
  learningDelta:
    "PHI is health information tied to an individual; identifiers plus health data create obligations across logs, backups, and vendors",
  objectives: [
    "Decide whether a field combination is PHI from the data, not from the system that stores it.",
    "Trace how PHI is copied into logs, analytics stores, and vendor exports.",
    "Distinguish validated de-identification from hashing, masking, or tokenization.",
    "Contain PHI that has reached an unapproved system and verify the fix.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
