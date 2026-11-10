import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Loss of one availability zone at peak with insufficient surviving capacity",
  accuracyNote:
    "This is an original composite, not a real company incident. It is not a real incident and does not describe any organization's architecture, dates, traffic, people, or internal decisions. It combines common capacity and failover failure modes; all times are relative and all telemetry is illustrative.",
  architecture: { id: "request-path" },
  timeline: [
    {
      at: "T+00:00",
      title: "Peak begins with three even zones",
      body: "Traffic reaches its daily peak. Each of the three zones carries about a third of the fleet, and average CPU sits near 60 percent. The runbook calls the fleet N+1 because any one zone can be lost.",
      tone: "info",
    },
    {
      at: "T+00:10",
      title: "One zone loses power",
      body: "Instances and network paths in one zone fail together. The load balancer removes the zone and redistributes its share to the two remaining zones.",
      tone: "warn",
    },
    {
      at: "T+00:12",
      title: "Surviving zones jump to 90 percent",
      body: "Each healthy zone now carries about 1.5 times its prior load. Utilization crosses the queueing knee, so latency rises much faster than the load increase alone would suggest.",
      tone: "danger",
    },
    {
      at: "T+00:20",
      title: "Autoscaling starts too late",
      body: "Scaling policies react to CPU, but new instances need minutes to launch and register. Capacity in the surviving zones is also constrained, so some launches queue behind available slots.",
      tone: "danger",
    },
    {
      at: "T+00:30",
      title: "The latency SLO breaks",
      body: "p99 triples, clients retry, and timeouts add load to an already saturated fleet. The failure is not absolute unavailability; it is a system too full to meet its latency promise.",
      tone: "danger",
    },
    {
      at: "T+00:40",
      title: "Load shedding protects checkout",
      body: "Admission control drops batch and low-priority search traffic. Checkout and payment keep a larger share of capacity, and error rates stop climbing.",
      tone: "warn",
    },
    {
      at: "T+00:55",
      title: "New capacity registers",
      body: "Instances finally come online in the healthy zones. Utilization falls below the knee, queues drain, and latency returns to the SLO range.",
      tone: "success",
    },
    {
      at: "T+01:20",
      title: "The failed zone returns",
      body: "The zone recovers gradually. Traffic rebalances, and the team avoids shifting load back too quickly while caches and connection pools warm.",
      tone: "success",
    },
    {
      at: "T+02:30",
      title: "Incident closed",
      body: "The review confirms the fleet had N+1 machines but N+0 latency headroom at peak. The distinction had never been written into the capacity target.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "first-mitigation",
      prompt: "Two surviving zones are at 90 percent and latency is climbing. What do you do first?",
      options: [
        {
          id: "shed",
          label: "Shed low-priority traffic and protect the critical request path.",
          consequence:
            "Utilization falls below the knee immediately, and checkout keeps its latency budget. The team buys time for autoscaling without pretending the fleet already has capacity.",
          quality: "good",
        },
        {
          id: "wait",
          label: "Wait for autoscaling to add instances to the healthy zones.",
          consequence:
            "Scaling takes minutes and may be constrained by available capacity. Latency continues to rise, and retries consume the headroom that the new instances were meant to provide.",
          quality: "mixed",
        },
        {
          id: "single-zone",
          label: "Move all traffic to the least-loaded zone to concentrate capacity.",
          consequence:
            "One zone now carries the entire fleet and saturates even faster. The move also removes the remaining redundancy if that zone has any issue.",
          quality: "poor",
        },
      ],
      debrief:
        "When the failure is already past the queueing knee, the fastest lever is demand, not supply. Shedding low-value work reduces utilization in seconds, while new capacity takes minutes and may not be available at all. Protecting the critical path is the reason to have a priority policy before the incident.",
    },
    {
      id: "headroom-math",
      prompt: "What was the actual headroom before the zone failed?",
      options: [
        {
          id: "post-failure",
          label: "About N+0 at the latency SLO: 60 percent per zone becomes 90 percent after one zone is lost.",
          consequence:
            "The team sees that three even zones at 60 percent leave only 10 points of utilization before the knee, which is not enough margin for queueing and retries at peak.",
          quality: "good",
        },
        {
          id: "average",
          label: "Comfortable: average utilization was around 40 percent across a full day.",
          consequence:
            "The average hides the peak and the post-failure redistribution. Capacity decisions based on it would repeat the same mistake at the next high-traffic event.",
          quality: "poor",
        },
        {
          id: "machine-count",
          label: "N+1, because the fleet could lose one zone and still have two zones running.",
          consequence:
            "Machine count is not the same as service capacity. The surviving zones stay up but cannot meet latency, so the availability claim is true only in the narrowest sense.",
          quality: "mixed",
        },
      ],
      debrief:
        "Headroom is a post-failure property measured at peak. With three equal zones, losing one multiplies the load on the survivors by 1.5. Sixty percent becomes 90 percent, and 90 percent is past the queueing knee for most latency-sensitive services. N+1 must mean the surviving fleet can carry peak within the SLO, not merely that it still has running instances.",
    },
    {
      id: "lasting-control",
      prompt: "How should capacity be planned so the next zone loss stays inside the SLO?",
      options: [
        {
          id: "post-failure-target",
          label: "Set a post-failure utilization target with queueing margin, reserve capacity, and test zone evacuation.",
          consequence:
            "The fleet keeps enough room for the largest failure at peak, and the target is verified by an exercise rather than a spreadsheet. Autoscaling becomes a second line of defense, not the primary plan.",
          quality: "good",
        },
        {
          id: "fourth-zone",
          label: "Add a fourth zone and assume the problem is solved.",
          consequence:
            "A fourth zone improves the arithmetic, but the same planning error can consume the extra margin. Without a post-failure target, the new capacity is treated as headroom for growth instead of failure.",
          quality: "mixed",
        },
        {
          id: "lower-slo",
          label: "Relax the latency SLO so the post-failure fleet is considered healthy.",
          consequence:
            "The numbers turn green while the user experience stays worse. This hides the capacity gap and removes the signal that would justify investment.",
          quality: "poor",
        },
      ],
      debrief:
        "The durable control is a target expressed after the failure: largest zone lost, peak traffic, utilization below the knee with margin for retries and variability. Pre-provisioning and reserved capacity make the target achievable without waiting for autoscaling, and a zone-evacuation exercise proves the target in practice.",
    },
  ],
  postmortem: [
    { type: "h3", text: "What happened" },
    {
      type: "p",
      text: "At peak, each of three zones carried about 60 percent utilization. One zone failed, and the remaining two took 1.5 times their prior load, rising to roughly 90 percent. That crossed the queueing knee, latency tripled, and the service missed its SLO even though the surviving zones stayed online.",
    },
    { type: "h3", text: "Why the runbook was wrong" },
    {
      type: "list",
      items: [
        "N+1 was defined by machine count, not by post-failure capacity against the latency SLO.",
        "The capacity plan used average utilization and did not evaluate the peak with one zone removed.",
        "Autoscaling was treated as immediate even though launches and registration take minutes.",
        "There was no priority policy to shed low-value traffic while capacity recovered.",
      ],
    },
    { type: "h3", text: "What changed" },
    {
      type: "list",
      items: [
        "The headroom target is defined after the largest failure at peak, with an explicit queueing margin.",
        "Critical-path capacity is reserved so autoscaling is not the only response.",
        "Admission control and shedding priorities are tested before they are needed.",
        "A zone-evacuation game day validates the math and the runbook each quarter.",
      ],
    },
    { type: "h3", text: "What generalizes" },
    {
      type: "p",
      text: "N+1 is a claim about service capacity, not about the number of running machines. The calculation must remove the failed domain, redistribute its load at peak, and compare the result against the point where latency becomes nonlinear. A fleet can be highly available in the sense that something is still running and still be unavailable in the sense users care about.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, utilization values, and latency observations in this file are illustrative. They describe a composite scenario, not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "Reliability Pillar",
      url: "https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html",
      publisher: "AWS Well-Architected Framework",
      kind: "docs",
      note: "Failure domains, static stability, and capacity planning.",
    },
    {
      title: "Static stability using Availability Zones",
      url: "https://aws.amazon.com/builders-library/static-stability-using-availability-zones/",
      publisher: "AWS Builders' Library",
      kind: "docs",
      note: "Designing for zone loss without depending on control-plane reaction.",
    },
    {
      title: "AWS fault isolation boundaries",
      url: "https://docs.aws.amazon.com/whitepapers/latest/aws-fault-isolation-boundaries/abstract-and-introduction.html",
      publisher: "AWS",
      kind: "docs",
      note: "How availability zones bound failure and what remains shared.",
    },
    {
      title: "Managing load",
      url: "https://sre.google/sre-book/managing-load/",
      publisher: "Google SRE",
      kind: "book",
      note: "Capacity, load shedding, and behavior near saturation.",
    },
  ],
};
