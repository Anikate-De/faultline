import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "public",
  company: "Amazon Web Services (AWS)",
  date: "February 28, 2017",
  incidentClass: "Accidental capacity removal and full-restart dependency in S3 us-east-1",
  accuracyNote:
    "Verified against AWS's public post-event summary for February 28, 2017: the 9:37 AM PST playbook command, the accidental removal of index and placement capacity, the recovery sequence, the Service Health Dashboard dependency, and AWS's stated follow-up actions. The report does not disclose the command, the number of servers removed, internal tooling details, or customer-side telemetry, so none are asserted here. What remains uncertain is whether other S3 subsystems shared the same untested full-restart risk; the report only says that index partitioning was reprioritized. Relative times are derived from the report's PST milestones; where the report gives only a sequence, this file says so. No quotation is attributed to an individual.",
  timeline: [
    {
      at: "T+00:00",
      title: "A routine capacity command removes too much",
      body: "An authorized S3 team member, debugging slower-than-expected billing progress, runs an established playbook command intended to remove a small number of servers used by the billing process. One input is entered incorrectly. The command removes a larger set, including capacity for the index and placement subsystems. The public report records the time as 9:37 AM PST.",
      tone: "danger",
    },
    {
      at: "T+02:00",
      title: "Status updates return after a two-hour gap",
      body: "The Service Health Dashboard administration console depends on S3 in the same region, so AWS cannot update individual service status there from the start of the event until 11:37 AM PST. It uses its Twitter feed and banner text in the meantime.",
      tone: "warn",
    },
    {
      at: "T+02:49",
      title: "Index capacity begins serving reads",
      body: "The index subsystem, which holds object metadata and location information for every object in the region, activates enough capacity to begin serving GET, LIST, and DELETE requests.",
      tone: "info",
    },
    {
      at: "T+03:41",
      title: "The index subsystem fully recovers",
      body: "GET, LIST, and DELETE APIs are functioning normally. The placement subsystem, which allocates storage for new objects and depends on the index, can now begin its own recovery.",
      tone: "info",
    },
    {
      at: "T+04:17",
      title: "Placement catches up",
      body: "Placement recovery completes and S3 is operating normally. The report says other AWS services had accumulated backlog during the disruption and needed additional time to recover.",
      tone: "success",
    },
    {
      at: "After T+04:17",
      title: "Dependent backlogs outlast the storage recovery",
      body: "The report does not give a single recovery time for every dependent service. It distinguishes S3 returning to normal from the longer tail of services that had queued work during the outage.",
      tone: "warn",
    },
  ],
  decisions: [
    {
      id: "restart-order",
      prompt: "The index and placement subsystems both need a full restart. What order do you choose?",
      options: [
        {
          id: "index-first",
          label: "Restart and validate the index subsystem first, then recover placement once the index is serving.",
          consequence:
            "This matches the documented dependency: placement allocates storage for new objects and requires a working index. GET, LIST, and DELETE begin returning before PUT does, but the read path returns first.",
          quality: "good",
        },
        {
          id: "placement-first",
          label: "Restore placement first so PUT traffic can resume sooner.",
          consequence:
            "Placement cannot complete its recovery without the index. Starting there delays the read path and does not produce a usable write path.",
          quality: "poor",
        },
        {
          id: "parallel-unbounded",
          label: "Restart both subsystems in parallel with no capacity limit.",
          consequence:
            "The report says the restart and its safety checks already took longer than expected. Unbounded parallel work adds load without removing the dependency, and may lengthen validation.",
          quality: "mixed",
        },
      ],
      debrief:
        "Recovery order follows the dependency graph, not the customer-visible API ranking. The report says placement recovery began when the index was functional, and that the index restart took longer than expected because the subsystem had not been fully restarted in the larger regions for years. The operational lesson is to exercise full-restart procedures at current scale before an incident, not to assume that per-server redundancy makes a subsystem restart trivial.",
    },
    {
      id: "status-channel",
      prompt: "The status page cannot publish because it depends on S3. How do you communicate?",
      options: [
        {
          id: "out-of-band",
          label: "Use channels that do not depend on the affected region, such as a banner and a social feed, while repairing the dashboard dependency.",
          consequence:
            "AWS did this until 11:37 AM PST, then restored individual service status. Customers get a signal even while the reporting tool is impaired.",
          quality: "good",
        },
        {
          id: "wait-for-dashboard",
          label: "Wait for the dashboard to recover before posting updates.",
          consequence:
            "The reporting gap lasts as long as the dependency outage. Customers see an empty or stale status page during the period they most need information.",
          quality: "poor",
        },
        {
          id: "same-region-static",
          label: "Host a static status page in the same region and rely on it.",
          consequence:
            "It may survive some failures, but it shares the region's fate. AWS later changed the dashboard administration console to run across multiple regions, which addresses region-level dependence.",
          quality: "mixed",
        },
      ],
      debrief:
        "A status page is part of the recovery path, not a neutral observer. If it shares a dependency with the service, it fails when the service fails. The durable fix is an out-of-band path with independent infrastructure and a communication cadence that does not wait for root cause.",
    },
    {
      id: "recovery-definition",
      prompt: "S3 APIs are normal again. When is the incident over for customers?",
      options: [
        {
          id: "dependent-backlog",
          label: "Track dependent services and backlog drain separately; keep the incident open until customer-facing work clears.",
          consequence:
            "This matches the report: other services had accumulated work and needed additional time after S3 recovered. It avoids declaring success while queues are still deep.",
          quality: "good",
        },
        {
          id: "api-green",
          label: "Close the incident when S3's APIs return to normal.",
          consequence:
            "The storage layer is healthy, but dependent services may still be failing or slow. Customers see a discrepancy between the status claim and their experience.",
          quality: "poor",
        },
        {
          id: "restart-dependents",
          label: "Restart every dependent service to force a clean state.",
          consequence:
            "Broad restarts add load and can create a second storm. The report points to accumulated backlog and additional recovery time, not to a blanket restart as the remedy.",
          quality: "poor",
        },
      ],
      debrief:
        "Recovery is a property of the customer journey, not a single API. The report separates S3 normal operation from the additional time other services needed. Incident command should define completion in terms of the original customer impact and verify the last dependent queue, not the first green dashboard.",
    },
  ],
  postmortem: [
    {
      type: "h3",
      text: "What happened",
    },
    {
      type: "p",
      text: "A capacity-removal command for the S3 billing workflow removed more servers than intended. The extra removals hit the index subsystem, which maps object metadata and locations, and the placement subsystem, which allocates storage for new objects. Both required a full restart. S3 could not serve requests while they restarted, and services that depend on S3, including the console, EC2 launches, EBS snapshot restores, and Lambda, were affected.",
    },
    {
      type: "h3",
      text: "Why it spread",
    },
    {
      type: "list",
      items: [
        "The index subsystem is on the path of every GET, LIST, PUT, and DELETE in the region; placement is on the PUT path.",
        "The index and placement subsystems had not been fully restarted in the larger regions for years, so the restart and its integrity checks took longer than expected.",
        "The status dashboard administration console used S3 in the same region, removing the usual communication channel during the outage.",
        "Dependent services accumulated backlog, so S3 recovery did not equal customer recovery.",
      ],
    },
    {
      type: "h3",
      text: "What changed",
    },
    {
      type: "list",
      items: [
        "The capacity-removal tool was changed to remove capacity more slowly and to block removals that would take a subsystem below its minimum required capacity.",
        "AWS said it would audit other operational tools for similar safeguards.",
        "The status dashboard administration console was changed to run across multiple AWS regions.",
        "S3 reprioritized partitioning the index subsystem into smaller cells to reduce recovery time.",
      ],
    },
    {
      type: "h3",
      text: "What generalizes",
    },
    {
      type: "p",
      text: "Two controls matter more than any single runbook: a capacity tool that cannot remove below a safe floor, and a recovery procedure that has been exercised at current scale. Redundancy absorbs server loss; it does not necessarily absorb the loss of a large fraction of a subsystem that has never been fully restarted. The incident also shows that a status page can be a hidden dependency. Test the communication path with the same seriousness as the data path.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Verified scope",
      body: "The subsystems, impacted services, times, and remediation items above come from the AWS post-event summary. The report does not provide request rates, server counts, or customer-level error percentages, and those are intentionally absent. Relative offsets are computed from the report's PST milestones.",
    },
  ],
  sources: [
    {
      title: "Summary of the Amazon S3 Service Disruption in the Northern Virginia (US-EAST-1) Region",
      url: "https://aws.amazon.com/message/41926/",
      publisher: "Amazon Web Services",
      kind: "postmortem",
      note: "Official post-event summary: cause, recovery sequence, dashboard dependency, and remediation.",
    },
    {
      title: "Resilience in Amazon S3",
      url: "https://docs.aws.amazon.com/AmazonS3/latest/userguide/disaster-recovery-resiliency.html",
      publisher: "Amazon Web Services",
      kind: "docs",
      note: "S3 resilience model and regional fault isolation.",
    },
    {
      title: "AWS Fault Isolation Boundaries",
      url: "https://docs.aws.amazon.com/whitepapers/latest/aws-fault-isolation-boundaries/abstract-and-introduction.html",
      publisher: "Amazon Web Services",
      kind: "standard",
      note: "Cells, partitions, and blast-radius design referenced by the S3 remediation.",
    },
  ],
};
