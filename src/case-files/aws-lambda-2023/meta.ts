import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-aws-lambda-2023",
  slug: "aws-lambda-2023",
  title: "Lambda us-east-1: When the Control Plane Is the Product",
  track: "case-files",
  order: 4,
  difficulty: 4,
  minutes: 22,
  prerequisites: ["containers-services"],
  tags: ["control plane", "data plane", "invocation", "scaling", "recovery"],
  productionQuestion:
    "Existing functions serve traffic but new invocations cannot be created. Is the service up?",
  learningDelta:
    "Control-plane and data-plane health are different; recovery and scaling depend on the control plane even when the data path works",
  objectives: [
    "Separate what is healthy from what is failing when only one Lambda cell is affected.",
    "Trace an invocation failure to execution-environment allocation rather than customer code.",
    "Choose a mitigation that reduces the scaling threshold instead of adding capacity into it.",
    "Design cellular scaling limits and alarms that catch allocation without utilization.",
    "Correct the common control-plane framing using the public report's actual failure path.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
