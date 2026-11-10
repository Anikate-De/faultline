import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "foundations-password-hashing",
  slug: "password-hashing",
  title: "Password Hashing: Cost, Salt, and Timing",
  track: "foundations",
  order: 26,
  difficulty: 2,
  minutes: 18,
  prerequisites: ["foundations-rate-limiting"],
  tags: ["password hashing", "bcrypt", "Argon2", "salt", "cost factor", "timing attack"],
  productionQuestion:
    "A leaked database contains unsalted SHA-256 hashes; what did the team get wrong?",
  learningDelta:
    "Password hashing uses a unique salt and a tunable work factor (bcrypt/Argon2); fast general-purpose hashes are the wrong tool",
  objectives: [
    "Explain why fast hashes such as SHA-256 are unsuitable for password storage.",
    "Choose a salt and work factor that make offline cracking expensive without breaking login latency.",
    "Avoid timing and error-message leaks in the login path.",
    "Plan a migration from a weak hash without invalidating every stored credential.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
