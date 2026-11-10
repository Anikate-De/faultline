import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "cloud-networking-igw",
  slug: "igw",
  title: "Internet Gateway",
  track: "cloud-networking",
  order: 5,
  difficulty: 1,
  minutes: 14,
  prerequisites: ["cloud-networking-vpc"],
  tags: ["internet gateway", "public IP", "route", "security group", "NAT"],
  productionQuestion:
    "A public subnet has a 0.0.0.0/0 route but still no internet. What is missing?",
  learningDelta:
    "An internet gateway attaches to the VPC and requires public IPs, routes, and security groups to work together",
  objectives: [
    "Explain what an internet gateway attaches to and what it does for IPv4 and IPv6.",
    "Check the full public path: address, security group, route, and gateway attachment.",
    "Separate a missing gateway, a missing route, a missing public address, and a blocking rule.",
    "Choose between an internet gateway, a NAT gateway, and an egress-only internet gateway.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
