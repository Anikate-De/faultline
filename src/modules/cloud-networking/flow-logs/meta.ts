import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "cloud-networking-flow-logs",
  slug: "flow-logs",
  title: "VPC Flow Logs",
  track: "cloud-networking",
  order: 30,
  difficulty: 2,
  minutes: 14,
  prerequisites: ["cloud-networking-security-groups"],
  tags: ["VPC Flow Logs", "ENI", "ACCEPT", "REJECT", "direction"],
  productionQuestion:
    "The app sees no request and the client sees a timeout. Did the packet reach the instance?",
  learningDelta:
    "Flow logs record accepted and rejected flows at the ENI; they show direction, action, and bytes, but not payload",
  objectives: [
    "Read a flow log record as a five-tuple plus action, direction, and bytes.",
    "Use ACCEPT and REJECT records to localize a drop to the security group or network ACL.",
    "Explain what a missing record does and does not prove.",
    "Choose the log point and fields that answer a specific packet question.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
