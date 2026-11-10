import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-aws-s3-2017",
  slug: "aws-s3-2017",
  title: "S3 us-east-1: The Control Plane That Took Down the Internet",
  track: "case-files",
  order: 1,
  difficulty: 4,
  minutes: 26,
  prerequisites: ["cloud-networking-vpc"],
  tags: ["control plane", "dependency", "restart storm", "status page", "recovery"],
  productionQuestion:
    "A storage service is down and the status page itself depends on it. What do you restore first?",
  learningDelta:
    "Control-plane dependencies and synchronized recovery can turn one service failure into a regional outage",
  objectives: [
    "Map the S3 dependencies that turned a capacity-removal mistake into a regional outage.",
    "Sequence recovery around the index and placement subsystems rather than around customer-visible APIs.",
    "Design a status-communication path that does not depend on the service being reported on.",
    "Evaluate capacity-removal tooling for minimum-capacity and rate safeguards.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
