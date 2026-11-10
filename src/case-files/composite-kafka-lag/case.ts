import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Consumer lag after a deploy, with one partition blocked by retries",
  accuracyNote:
    "This is an original composite case file, not a real incident and not a real company incident. It combines common deployment, consumer-lag, partition-parallelism, and poison-record failure modes into one representative scenario. It does not describe any company's architecture, dates, traffic, or internal decisions. All relative times and telemetry are illustrative.",
  timeline: [
    {
      at: "T+00:00",
      title: "A new consumer version deploys",
      body: "The release adds a synchronous enrichment call to every record. Median processing time rises from about forty milliseconds to just under one hundred, which is still acceptable per record.",
      tone: "info",
    },
    {
      at: "T+00:12",
      title: "Lag crosses the alert threshold",
      body: "The consumer group falls behind production by roughly forty-five minutes. Throughput is below the incoming rate, so lag grows by about ten minutes every hour.",
      tone: "warn",
    },
    {
      at: "T+00:26",
      title: "Scaling does not help",
      body: "The topic has twelve partitions and already has one consumer per partition. Adding consumers leaves the extra instances idle, and the per-record cost remains elevated.",
      tone: "danger",
    },
    {
      at: "T+00:32",
      title: "The deploy is rolled back",
      body: "On-call rolls back the consumer version. Processing time returns to its previous range, and consumption rate rises above production for most partitions.",
      tone: "success",
    },
    {
      at: "T+00:58",
      title: "Most of the backlog drains",
      body: "Eleven partitions reduce their lag steadily. One partition remains flat, then begins to grow again even though the group has spare capacity.",
      tone: "warn",
    },
    {
      at: "T+01:10",
      title: "A poison record blocks the partition",
      body: "Consumer logs show the same offset being retried. The record triggers a deterministic error in the enrichment step, and the retry policy has no attempt limit or dead-letter path.",
      tone: "danger",
    },
    {
      at: "T+01:16",
      title: "The record is quarantined",
      body: "After a bounded number of retries, the record is written to a dead-letter topic and the partition advances. The remaining backlog drains without further intervention.",
      tone: "success",
    },
    {
      at: "T+03:30",
      title: "Lag returns to normal",
      body: "The group is within five minutes of the head of the topic. Peak lag stayed inside the twenty-four-hour retention window, but only because the blocked partition was found before it crossed the limit.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "first-move",
      prompt:
        "The deploy doubled per-record processing time and lag is growing. What is the first move?",
      options: [
        {
          id: "rollback",
          label: "Roll back the consumer deploy and confirm processing time returns to baseline.",
          consequence:
            "The consumption rate recovers before the backlog becomes a retention risk. The team can then investigate the added call while the backlog drains with the previous version.",
          quality: "good",
        },
        {
          id: "scale-out",
          label: "Add consumer instances until lag starts falling.",
          consequence:
            "The topic has one consumer per partition already, so new instances sit idle. Even with free partitions, each record still costs more to process, and the backlog keeps growing.",
          quality: "mixed",
        },
        {
          id: "increase-retention",
          label: "Extend topic retention so the backlog has more time.",
          consequence:
            "The immediate data-loss risk falls, but consumption is still slower than production. The backlog continues to grow and the retention change hides the recovery problem instead of solving it.",
          quality: "mixed",
        },
      ],
      debrief:
        "When a deploy changes per-record cost and the system is already behind, rollback is the shortest path back to the previous consumption rate. Scaling is constrained by partition count and does not reduce the cost of each record. Retention buys time but does not restore the balance between production and consumption.",
    },
    {
      id: "stuck-partition",
      prompt: "After rollback, eleven partitions drain but one stays flat. What do you check?",
      options: [
        {
          id: "per-partition",
          label:
            "Compare per-partition lag and inspect the stuck consumer's retry logs for a repeated offset.",
          consequence:
            "The repeated offset identifies a poison record, and the team can quarantine it with a bounded retry policy. The healthy partitions continue to drain while the blocked one is repaired.",
          quality: "good",
        },
        {
          id: "add-consumers",
          label: "Add more consumers to the group to increase parallelism.",
          consequence:
            "Consumers beyond the partition count remain idle, and the stuck partition still processes one record at a time. The action adds cost without changing the bottleneck.",
          quality: "poor",
        },
        {
          id: "restart-group",
          label: "Restart the entire consumer group to clear the stuck state.",
          consequence:
            "A full restart triggers rebalancing and reprocesses from the last committed offsets. The poison record is likely to block the partition again, now with more disruption.",
          quality: "poor",
        },
      ],
      debrief:
        "Group-level lag can hide a single partition that is not advancing. Per-partition lag and retry logs separate a slow consumer from a blocked one. If the same offset recurs, the problem is the record or its handling, and more consumers cannot help.",
    },
    {
      id: "lasting-control",
      prompt: "Which set of controls best prevents this class of incident?",
      options: [
        {
          id: "bounded-retry",
          label:
            "Bound retries with a dead-letter path, make processing idempotent, and gate deploys on processing time.",
          consequence:
            "A bad record cannot block a partition indefinitely, a replay is safe, and a regression in per-record cost is caught before rollout. The consumer gains explicit failure semantics.",
          quality: "good",
        },
        {
          id: "more-partitions",
          label: "Increase the partition count so the group can always add consumers.",
          consequence:
            "More partitions improve maximum parallelism, but they do not help a single blocked partition or a slower per-record path. The change adds operational overhead without addressing either failure.",
          quality: "mixed",
        },
        {
          id: "longer-retention",
          label: "Keep a multi-day retention window and alert on lag at a higher threshold.",
          consequence:
            "There is more time to react before data expires, but the alert fires later and the underlying processing or blocking issue remains. Retention becomes a substitute for recovery.",
          quality: "mixed",
        },
      ],
      debrief:
        "Lag is a rate comparison, and recovery needs both sides: production rate and consumption rate. Bounded retries protect the partition, idempotency makes replay safe, and a deploy gate on processing time protects the consumption rate. Partition count and retention are capacity and safety margins, not fixes for a blocked or slower consumer.",
    },
  ],
  postmortem: [
    {
      type: "h3",
      text: "What happened",
    },
    {
      type: "p",
      text: "A consumer release added a synchronous call that nearly doubled per-record processing time. Because the topic already had one consumer per partition, scaling could not restore throughput, and lag grew until the release was rolled back. One partition then remained blocked by a deterministic bad record with unlimited retries, which kept the group from fully recovering until the record was quarantined.",
    },
    {
      type: "h3",
      text: "Why it lasted",
    },
    {
      type: "list",
      items: [
        "The deploy gate measured error rate but not per-record processing time or lag trend.",
        "Consumer parallelism was capped by the partition count, which was not considered during the incident.",
        "Retries had no attempt limit or dead-letter path, so one record could hold a partition indefinitely.",
        "The primary lag dashboard showed group totals, which masked the single partition that was not advancing.",
      ],
    },
    {
      type: "h3",
      text: "What changed",
    },
    {
      type: "list",
      items: [
        "Consumer deploys canary on processing time and lag slope, not only error rate.",
        "Retries are bounded, and exhausted records go to a monitored dead-letter topic.",
        "Processing is idempotent so a quarantined record can be replayed safely.",
        "Lag alerts break down by partition and distinguish growing, draining, and blocked states.",
      ],
    },
    {
      type: "h3",
      text: "What generalizes",
    },
    {
      type: "p",
      text: "Consumer lag is a balance sheet: production adds to it, consumption removes from it, and partitions limit how much consumption can be parallelized. A slower per-record path changes the balance everywhere; a poison record changes it on one partition only. Diagnosis starts with per-partition rates, and recovery starts with restoring the consumption rate or unblocking the partition, not with adding capacity that the partition layout cannot use.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, processing figures, and lag observations in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "Kafka Design",
      url: "https://kafka.apache.org/documentation/#design",
      publisher: "Apache Kafka Documentation",
      kind: "docs",
      note: "Partitions, consumer groups, ordering, and parallelism.",
    },
    {
      title: "Consumer Configs",
      url: "https://kafka.apache.org/documentation/#consumerconfigs",
      publisher: "Apache Kafka Documentation",
      kind: "docs",
      note: "Offset commits, fetch behavior, and consumer configuration.",
    },
    {
      title: "Kafka: The Definitive Guide",
      url: "https://www.oreilly.com/library/view/kafka-the-definitive/9781492043072/",
      publisher: "O'Reilly Media",
      kind: "book",
      note: "Consumer lag, partition limits, and delivery semantics.",
    },
    {
      title: "Managing Load",
      url: "https://sre.google/workbook/managing-load/",
      publisher: "Google SRE Workbook",
      kind: "book",
      note: "Backpressure, queueing, and overload response.",
    },
  ],
};
