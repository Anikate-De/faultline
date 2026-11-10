import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "NAT port and conntrack exhaustion under connection churn",
  accuracyNote:
    "This is an original composite, not a real company incident. It is not a real incident and does not describe any organization's architecture, dates, traffic, people, or internal decisions. It combines common egress, NAT, and conntrack failure modes; all times are relative and all telemetry is illustrative.",
  architecture: { id: "vpc-path" },
  timeline: [
    {
      at: "T+00:00",
      title: "Peak traffic begins",
      body: "A scheduled promotion raises request volume. Most of the growth is short-lived calls to a third-party API, so connection churn rises much faster than bytes transferred.",
      tone: "info",
    },
    {
      at: "T+00:05",
      title: "New outbound connections fail",
      body: "Clients see connect timeouts to the partner API while established connections continue to work. Egress bandwidth is below a third of its limit, and packet loss is normal.",
      tone: "warn",
    },
    {
      at: "T+00:12",
      title: "Retries add more churn",
      body: "Client libraries retry failed connects. Each retry creates a new flow, so the number of attempted translations climbs while the number of successful requests stays flat.",
      tone: "warn",
    },
    {
      at: "T+00:20",
      title: "Bandwidth is ruled out",
      body: "Responders check interface throughput, packet loss, and DNS. All look healthy, and the failures are specific to new flows rather than to a destination or an application instance.",
      tone: "info",
    },
    {
      at: "T+00:35",
      title: "The NAT limit becomes visible",
      body: "Port allocation errors appear on the NAT gateway, and the conntrack table sits at its limit. Idle timeouts are short, health checks open a new flow every few seconds, and clients have no connection pooling.",
      tone: "danger",
    },
    {
      at: "T+00:50",
      title: "Churn is reduced",
      body: "The team enables pooling, raises keep-alive lifetime, and staggers health checks. New flows per second fall sharply, and some connections begin to succeed again.",
      tone: "warn",
    },
    {
      at: "T+01:10",
      title: "Egress is spread",
      body: "Additional NAT gateways in other zones take new flows after route changes. Port pressure per gateway drops below the limit, and the conntrack table drains.",
      tone: "success",
    },
    {
      at: "T+01:40",
      title: "Partner calls recover",
      body: "Connect success returns to baseline and retries stop. The team keeps the churn controls in place rather than reverting them after the peak.",
      tone: "success",
    },
    {
      at: "T+02:30",
      title: "Incident closed",
      body: "The review shows that bandwidth dashboards were green throughout. The resource that failed was a translation table measured in flows, not bits per second.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "first-diagnostic",
      prompt: "New outbound connections fail while bandwidth is low. What do you check first?",
      options: [
        {
          id: "nat-signals",
          label: "Check NAT port allocation, conntrack table usage, and new-flow rate.",
          consequence:
            "The exhausted table and high churn are visible immediately. The team knows the failure is per-flow, so it stops looking at bandwidth and starts reducing connection creation.",
          quality: "good",
        },
        {
          id: "bandwidth",
          label: "Add egress bandwidth and request a limit increase.",
          consequence:
            "The pipe was never full, so the added capacity changes nothing. The request takes time and may create a false sense that the constraint has been addressed.",
          quality: "poor",
        },
        {
          id: "scale-app",
          label: "Scale the application so more instances can retry the calls.",
          consequence:
            "More instances create more flows and accelerate exhaustion. The failure is in shared egress translation, so adding callers makes the constraint tighter.",
          quality: "mixed",
        },
      ],
      debrief:
        "NAT and conntrack are flow-count resources. Their limits can be reached while throughput and packet loss look healthy, because many short connections consume translation state without moving much data. The first check should compare new-flow rate and table occupancy against their limits, not compare bytes against link capacity.",
    },
    {
      id: "immediate",
      prompt: "The NAT table is at its limit and the peak is still rising. What is the fastest safe mitigation?",
      options: [
        {
          id: "reduce-churn",
          label: "Cut connection churn with pooling, longer keep-alive, and staggered health checks.",
          consequence:
            "Fewer new flows per second free translation entries for useful traffic. The change is reversible and does not require replacing the NAT path during the peak.",
          quality: "good",
        },
        {
          id: "raise-table",
          label: "Raise the conntrack table limit and shorten idle timeout.",
          consequence:
            "A larger table buys time, but shorter idle timeouts create more churn and can evict flows that are still needed. It treats the ceiling without reducing the rate of arrival.",
          quality: "mixed",
        },
        {
          id: "restart-nat",
          label: "Restart the NAT gateway to clear the table.",
          consequence:
            "All active flows through that gateway are dropped, turning a partial failure into a broad outage for every dependent service. The table refills as soon as traffic resumes.",
          quality: "poor",
        },
      ],
      debrief:
        "Clearing a full table is not the same as reducing demand. The durable lever is fewer new flows: reuse connections, keep them alive longer, and stop probes from opening a flow per check. Adding gateways spreads the remaining churn and is a useful second step, but the rate has to come down or the new capacity fills too.",
    },
    {
      id: "lasting-control",
      prompt: "How should egress be designed so the next peak does not exhaust ports?",
      options: [
        {
          id: "churn-model",
          label: "Size NAT per zone from new-flow rate, pool connections by default, and alert on allocation errors.",
          consequence:
            "Capacity tracks the resource that actually fails, and per-zone gateways keep one failure from taking all egress. Allocation errors become an early warning rather than a surprise.",
          quality: "good",
        },
        {
          id: "bandwidth-alerts",
          label: "Keep bandwidth alerts and add more egress capacity when they fire.",
          consequence:
            "The existing alerts stay green through this failure mode. Capacity grows in the dimension that was never constrained while port pressure remains unobserved.",
          quality: "poor",
        },
        {
          id: "single-nat",
          label: "Consolidate to one large NAT gateway to simplify routing and cost.",
          consequence:
            "Consolidation reduces per-gateway overhead but creates a single port pool and a single failure domain. A churn spike or zone loss now affects all private-subnet egress at once.",
          quality: "poor",
        },
      ],
      debrief:
        "Egress capacity has at least two dimensions: bits per second and concurrent or new flows per second. Healthy bandwidth graphs say nothing about the second. Model ports per gateway against peak churn, keep a pool of gateways across zones, and make connection reuse the default in clients. Alert on allocation failures, not only on throughput.",
    },
  ],
  postmortem: [
    { type: "h3", text: "What happened" },
    {
      type: "p",
      text: "A traffic peak multiplied short-lived outbound connections. The NAT gateway exhausted its available translation ports and the conntrack table reached its limit, so new flows failed while established connections and bandwidth remained healthy. Retries added more new flows and deepened the exhaustion.",
    },
    { type: "h3", text: "Why it was missed" },
    {
      type: "list",
      items: [
        "Dashboards tracked egress bandwidth and packet loss but not port allocation or table occupancy.",
        "Clients opened a new connection per call, and health checks created a steady flow churn even at idle.",
        "Idle timeouts were short, so entries were recycled quickly but the churn rate stayed high.",
        "One NAT path served most private subnets, concentrating every new flow in a single port pool.",
      ],
    },
    { type: "h3", text: "What changed" },
    {
      type: "list",
      items: [
        "NAT capacity is sized from peak new-flow rate with headroom, not from average throughput.",
        "Connection pooling and longer keep-alive are defaults in shared clients.",
        "Health-check intervals are staggered to avoid synchronized flow creation.",
        "Alerts cover port allocation errors, conntrack occupancy, and new-flow rate per gateway.",
      ],
    },
    { type: "h3", text: "What generalizes" },
    {
      type: "p",
      text: "When new connections fail but old ones work, the problem is usually state or identity, not bandwidth: a full translation table, an exhausted port range, or a connection limit. Churn is the hidden multiplier. The cheapest fix is almost always to create fewer connections, and the durable fix is to measure the flow-count resource directly.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, rates, and table observations in this file are illustrative. They describe a composite scenario, not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "NAT gateways",
      url: "https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html",
      publisher: "Amazon VPC",
      kind: "docs",
      note: "NAT gateway behavior, scaling, and port allocation.",
    },
    {
      title: "Troubleshoot NAT gateways",
      url: "https://docs.aws.amazon.com/vpc/latest/userguide/nat-gateway-troubleshooting.html",
      publisher: "Amazon VPC",
      kind: "docs",
      note: "Port allocation errors and connection tracking symptoms.",
    },
    {
      title: "Netfilter conntrack sysctl parameters",
      url: "https://docs.kernel.org/networking/nf_conntrack-sysctl.html",
      publisher: "Linux Kernel Documentation",
      kind: "docs",
      note: "Connection tracking table size and timeout behavior.",
    },
    {
      title: "RFC 3022: Traditional IP Network Address Translator",
      url: "https://www.rfc-editor.org/rfc/rfc3022",
      publisher: "IETF",
      kind: "standard",
      note: "NAT translation and port multiplexing fundamentals.",
    },
  ],
};
