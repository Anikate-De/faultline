import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-s3-endpoint-policy",
  slug: "composite-s3-endpoint-policy",
  title: "Composite: The Endpoint Policy That Blocked Backups",
  track: "case-files",
  order: 56,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["cloud-networking-s3-gateway-endpoint"],
  tags: ["VPC endpoint", "policy", "S3", "private subnet", "backup"],
  productionQuestion:
    "A backup job fails only in the private subnet after an endpoint policy change. What do you check?",
  learningDelta:
    "VPC endpoint policies and route tables both gate private AWS access; allowing the route does not allow the action",
  objectives: [
    "Separate a routing failure from an authorization failure on a private S3 path.",
    "Evaluate identity, bucket, and endpoint policies as independent gates.",
    "Recognize that object actions and bucket-level actions need different resource ARNs.",
    "Add a private-path canary so policy changes fail before the nightly backup does.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
