import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Cross-region data transfer cost growth after a service move",
  accuracyNote:
    "This is an original composite scenario, not a real incident. It combines common service-placement, traffic-path, and cost-attribution failures into one representative billing event. It is not a real company incident and does not describe any organization's architecture, traffic, dates, or internal decisions. All costs, rates, and timings are illustrative.",
  timeline: [
    {
      at: "Quarter 1",
      title: "A service moves for latency",
      body: "A read-heavy service is relocated to a second region to sit closer to its users. Its search dependency, batch enrichment jobs, and logging pipeline stay in the original region. The migration review covers latency and availability but not data transfer.",
      tone: "info",
    },
    {
      at: "Month 1",
      title: "The bill rises modestly",
      body: "Network charges increase by less than a fifth. The change is absorbed by a shared platform budget, so no single team sees it as a signal.",
      tone: "info",
    },
    {
      at: "Month 2",
      title: "The bill doubles",
      body: "Finance reports a sustained increase in inter-region transfer. The billing export has account and region but no service, endpoint, or request path, so the largest line cannot be attributed to an owner.",
      tone: "warn",
    },
    {
      at: "Day 1",
      title: "Flow data is joined to ownership",
      body: "Flow records show that one service pair accounts for most of the increase. The read service calls the enrichment service once per user request, exchanging a large response, and both directions cross the regional boundary.",
      tone: "warn",
    },
    {
      at: "Day 2",
      title: "Chatter is separated from bulk transfer",
      body: "The team finds a per-request payload that is mostly unchanged, plus a smaller batch path. The request pattern, not a single large migration, is driving the cost. NAT processing and inter-zone hops add to the same path.",
      tone: "danger",
    },
    {
      at: "Day 5",
      title: "A topology fix is tested",
      body: "The read path is co-located with enrichment, and repeated responses are cached for a short window. Cross-region bytes fall sharply while p99 stays inside the SLO.",
      tone: "success",
    },
    {
      at: "Day 20",
      title: "Cost becomes a service metric",
      body: "The team adds estimated transfer cost per thousand requests to its dashboard and tags the remaining cross-region paths. New services must declare their data-flow direction in the design review.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "attribute-the-path",
      prompt: "The bill doubled and no one can name the path. How do you attribute it?",
      options: [
        {
          id: "flow-and-tags",
          label: "Join flow records with service ownership and routing metadata to identify the top talkers.",
          consequence:
            "The largest byte flows are tied to concrete service pairs and paths. The team can separate request chatter from bulk transfer and assign the cost to the group that controls the call pattern.",
          quality: "good",
        },
        {
          id: "billing-export",
          label: "Group the billing export by account and region and charge the largest account.",
          consequence:
            "The export shows where spend landed, not which service created it. A shared account absorbs the cost, and the team with the actual lever remains unaware.",
          quality: "mixed",
        },
        {
          id: "largest-service",
          label: "Assume the highest-spend service is responsible and ask it to reduce usage.",
          consequence:
            "Spend and transfer are different dimensions. The team may throttle a healthy workload while the chatty path continues, and the bill stays high.",
          quality: "poor",
        },
      ],
      debrief:
        "Cost attribution needs topology, not just totals. Billing data tells you where the charge appears; flow data tells you which endpoints exchanged bytes; ownership metadata tells you who can change the behavior. Joining all three turns a finance surprise into an engineering task.",
    },
    {
      id: "mitigate",
      prompt: "The top path is a per-request call across regions. What is the first mitigation?",
      options: [
        {
          id: "co-locate-and-cache",
          label: "Co-locate the chatty dependency or add a short-lived cache for repeated responses.",
          consequence:
            "The number of boundary crossings and the bytes per request both fall. Latency usually improves as well, because the call no longer traverses two regional networks.",
          quality: "good",
        },
        {
          id: "compress",
          label: "Compress the response payload and keep the same call pattern.",
          consequence:
            "Compression reduces bytes per call but leaves the request rate and round trips unchanged. It helps the bill at the margin and adds CPU cost on both sides.",
          quality: "mixed",
        },
        {
          id: "commitment",
          label: "Buy a committed-spend discount to offset the higher transfer charge.",
          consequence:
            "Commitments can lower unit prices for eligible usage, but they do not change the path that creates the cost and may lock in the inefficient design. The team still cannot explain the bill.",
          quality: "poor",
        },
      ],
      debrief:
        "Data transfer is a function of topology and call frequency as much as payload size. Moving the dependency, caching repeated reads, or batching requests changes the shape of the traffic. Compression is useful, but it does not address the round trips that dominate a chatty path.",
    },
    {
      id: "keep-it-visible",
      prompt: "What control keeps egress cost from becoming invisible again?",
      options: [
        {
          id: "per-service-budget",
          label: "Publish transfer cost per service and per request, with an owner and a design-review check.",
          consequence:
            "The team that changes the call pattern sees the cost and can compare architectures before rollout. A budget creates a threshold for review without turning every optimization into a finance project.",
          quality: "good",
        },
        {
          id: "monthly-review",
          label: "Review the network bill in a monthly platform meeting.",
          consequence:
            "The increase is noticed, but a month after the change and without a direct owner. The lag makes it harder to connect the cost to the deployment that caused it.",
          quality: "mixed",
        },
        {
          id: "central-absorb",
          label: "Keep transfer in a central shared budget so product teams are not distracted.",
          consequence:
            "Product teams optimize what they can see. If transfer is invisible to them, the cheapest architecture for the product remains the most expensive for the platform.",
          quality: "poor",
        },
      ],
      debrief:
        "Cost becomes a engineering input only when it is attributable and timely. Per-service unit economics make the tradeoff visible at design time, and an owner ensures someone can act. The goal is not to minimize every byte; it is to make the cost of a topology choice explicit.",
    },
  ],
  postmortem: [
    {
      type: "h3",
      text: "What happened",
    },
    {
      type: "p",
      text: "A service moved regions to improve user latency, but its most frequent dependency stayed behind. Every user request crossed the regional boundary twice with a large response. The bill doubled over two months, and the existing cost reports could not identify the path.",
    },
    {
      type: "h3",
      text: "What made it worse",
    },
    {
      type: "list",
      items: [
        "The migration review covered latency and availability but did not model data transfer.",
        "Billing data had account and region dimensions but no service or endpoint attribution.",
        "The cost landed in a shared platform budget, so no product team saw the increase.",
        "The call pattern was chatty by design; payload size alone did not explain the bill.",
      ],
    },
    {
      type: "h3",
      text: "What changed",
    },
    {
      type: "list",
      items: [
        "Flow records are joined with ownership tags and retained long enough to investigate a quarter.",
        "Chatty read paths are co-located or cached, and batch calls are separated from user requests.",
        "Dashboards show estimated transfer cost per thousand requests for each service.",
        "Design reviews require a declared data-flow direction and an estimate for new cross-region calls.",
      ],
    },
    {
      type: "h3",
      text: "What generalizes",
    },
    {
      type: "p",
      text: "Egress cost is an architecture property. It follows the number of boundary crossings, the request rate, and the payload, in that order for most chatty systems. A bill without topology tells you that something changed, not what to fix. Attribution requires flow data, ownership metadata, and a unit-cost view close enough to the team making the call.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All charges, byte volumes, and request rates in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "Overview of data transfer costs for common architectures",
      url: "https://aws.amazon.com/blogs/architecture/overview-of-data-transfer-costs-for-common-architectures/",
      publisher: "Amazon Web Services",
      kind: "docs",
      note: "How boundary crossings and common architecture patterns create transfer charges.",
    },
    {
      title: "VPC Flow Logs",
      url: "https://docs.aws.amazon.com/vpc/latest/userguide/flow-logs.html",
      publisher: "Amazon Web Services",
      kind: "docs",
      note: "Flow records for source, destination, bytes, and path analysis.",
    },
    {
      title: "Cost Optimization Pillar",
      url: "https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/welcome.html",
      publisher: "AWS Well-Architected",
      kind: "docs",
      note: "Cost awareness, attribution, and design tradeoffs.",
    },
  ],
};
