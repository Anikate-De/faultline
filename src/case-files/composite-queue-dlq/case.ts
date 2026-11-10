import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Silent data loss through an unmonitored dead-letter queue",
  accuracyNote:
    "This is an original composite scenario, not a real incident and not a real company incident. It combines common queue, dead-letter, replay, and ownership failure modes into one representative scenario. It does not describe any company's architecture, traffic, dates, or internal decisions. All times are relative and all telemetry is illustrative.",
  timeline: [
    {
      at: "Day 0",
      title: "A producer deploy changes an event field",
      body: "A new producer version writes a nested payload where consumers expect a flat string. The producer is deployed gradually, so only a subset of events use the new shape.",
      tone: "warn",
    },
    {
      at: "Day 1",
      title: "Consumers reject the new events",
      body: "Deserialization fails before business logic runs. The consumer retries a few times, then routes each failed event to a dead-letter queue and acknowledges it. Main-queue depth looks normal.",
      tone: "warn",
    },
    {
      at: "Day 3",
      title: "The DLQ becomes a quiet backlog",
      body: "Failed events accumulate at a steady rate. There is no alarm on DLQ depth, no owner, and no dashboard. The only queue alert watches the main queue, which is draining successfully.",
      tone: "danger",
    },
    {
      at: "Day 9",
      title: "Downstream totals drift",
      body: "A weekly reconciliation shows missing records for one event type. The gap is small relative to total volume, so it is initially treated as a reporting delay rather than data loss.",
      tone: "warn",
    },
    {
      at: "Day 14",
      title: "Retention expires the oldest messages",
      body: "The DLQ retains messages for 14 days. The first failed events are deleted before anyone inspects them. The remaining backlog is still growing and now has an unrecoverable prefix.",
      tone: "danger",
    },
    {
      at: "Day 19",
      title: "The backlog is discovered",
      body: "An engineer traces a missing customer update back to the DLQ. It holds roughly two million messages. The team confirms the consumer, not the queue, is rejecting them.",
      tone: "danger",
    },
    {
      at: "Day 20",
      title: "Replay begins in controlled batches",
      body: "The consumer is fixed and deployed. Replay starts with a small batch to verify idempotency, then expands. Messages older than the retention window are reconstructed from the producer's source data where possible.",
      tone: "info",
    },
    {
      at: "Day 24",
      title: "The DLQ is empty and owned",
      body: "The backlog is processed, the unrecoverable set is documented, and the queue gets an owner, an age alarm, and a tested replay procedure.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "first-signal",
      prompt: "You learn that a downstream dataset is missing records. What should you check first?",
      options: [
        {
          id: "dlq-age-depth",
          label: "Check dead-letter depth, message age, and the consumer's failure reason.",
          consequence:
            "The DLQ is identified immediately, and the age distribution shows how much of the backlog is still recoverable. The failure reason points to the schema change before replay begins.",
          quality: "good",
        },
        {
          id: "main-queue",
          label: "Check main-queue depth and consumer throughput.",
          consequence:
            "Both look healthy because failed events were acknowledged and moved aside. The investigation loses time and may conclude that the queue is not involved.",
          quality: "poor",
        },
        {
          id: "scale-consumers",
          label: "Scale the consumer group to increase throughput.",
          consequence:
            "More consumers process the same poison events faster and fill the DLQ sooner. The missing records remain missing, and replay becomes larger.",
          quality: "poor",
        },
      ],
      debrief:
        "A DLQ is part of the failure path, not a parking lot outside it. The first signals are depth, age, and failure reason. Depth alone can look stable if producers are slow; age shows whether messages are approaching retention. Main-queue health cannot answer whether work was diverted.",
    },
    {
      id: "replay-order",
      prompt: "The consumer fix is ready. How do you replay two million failed events?",
      options: [
        {
          id: "batched-idempotent",
          label: "Replay a small batch, verify idempotency, then increase gradually with checkpoints.",
          consequence:
            "The team catches duplicate side effects and ordering problems while the blast radius is small. Checkpoints make the replay resumable and keep downstream load within capacity.",
          quality: "good",
        },
        {
          id: "bulk-replay",
          label: "Replay the entire backlog as fast as possible to catch up.",
          consequence:
            "The backlog clears quickly, but downstream systems receive a concentrated burst. Duplicate or out-of-order processing can create new corruption that is harder to undo than the original gap.",
          quality: "poor",
        },
        {
          id: "delete-backlog",
          label: "Delete the backlog and ask producers to resend only recent events.",
          consequence:
            "The queue becomes clean, but older events are lost unless the producer retains them. This converts an operational backlog into permanent data loss without a reconciliation record.",
          quality: "poor",
        },
      ],
      debrief:
        "Replay is a write workload with the same risks as any backfill. Start small, prove idempotency, and keep checkpoints. Retention determines what is still replayable, so the recovery plan must separate recoverable messages from the unrecoverable prefix. Bulk replay is attractive because it clears the visible symptom, but it can amplify load and duplicate effects.",
    },
    {
      id: "lasting-control",
      prompt: "What would have turned this from silent loss into a detected, recoverable failure?",
      options: [
        {
          id: "owner-and-age",
          label: "Assign an owner, alert on DLQ message age, and keep a tested replay runbook.",
          consequence:
            "The queue becomes an owned failure surface. Age alerts fire before retention deletes evidence, and the runbook makes recovery a practiced procedure rather than an incident-time invention.",
          quality: "good",
        },
        {
          id: "depth-only",
          label: "Alert when DLQ depth exceeds a fixed threshold.",
          consequence:
            "A threshold may catch a large burst, but a slow trickle can stay below it while silently exceeding retention. Depth also says nothing about how much time remains to act.",
          quality: "mixed",
        },
        {
          id: "disable-dlq",
          label: "Send failures back to the main queue indefinitely instead of a DLQ.",
          consequence:
            "Failures stay visible in the main queue, but poison messages can block progress and consume retry capacity. The system trades silent loss for a stuck consumer.",
          quality: "poor",
        },
      ],
      debrief:
        "The control is ownership plus time. An alarm on the oldest message age fires while replay is still possible, regardless of traffic shape. A named owner ensures someone interprets it. Retention must exceed the expected detection and repair window, and the replay path must be tested before the backlog exists.",
    },
  ],
  postmortem: [
    {
      type: "h3",
      text: "What happened",
    },
    {
      type: "p",
      text: "A producer changed an event field, and one consumer could not deserialize the new shape. The consumer retried, then moved each failed event to a DLQ and acknowledged it. Because only the main queue was monitored, the failure was invisible. By the time a reconciliation gap was traced back, retention had deleted the oldest messages.",
    },
    {
      type: "h3",
      text: "What made it worse",
    },
    {
      type: "list",
      items: [
        "The DLQ had no owner, dashboard, or alert on depth or message age.",
        "Retention was shorter than the time it took to detect and investigate the gap.",
        "The consumer acknowledged messages after moving them, so the main queue reported healthy progress.",
        "No replay tooling existed; the first replay was designed during the incident.",
      ],
    },
    {
      type: "h3",
      text: "What changed",
    },
    {
      type: "list",
      items: [
        "The DLQ is an owned queue with alarms on message age and an on-call route.",
        "Retention exceeds the detection and repair window, and expiry is recorded.",
        "Replay runs in idempotent batches with checkpoints and a documented unrecoverable set.",
        "Producer and consumer schemas are compatibility-tested before rollout.",
      ],
    },
    {
      type: "h3",
      text: "What generalizes",
    },
    {
      type: "p",
      text: "A DLQ converts an immediate failure into deferred work. That is useful only if someone is responsible for the deferred work and can still perform it. Monitor age, not just count; retain long enough to recover; and practice replay before it is urgent. A queue that accepts failures silently is a data-loss mechanism with extra steps.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, message counts, and retention observations in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "Amazon SQS dead-letter queues",
      url: "https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html",
      publisher: "Amazon Web Services",
      kind: "docs",
      note: "Redrive policy, retention, and DLQ behavior.",
    },
    {
      title: "Dead-letter topics",
      url: "https://cloud.google.com/pubsub/docs/dead-letter-topics",
      publisher: "Google Cloud",
      kind: "docs",
      note: "Forwarding failed messages and replay considerations.",
    },
    {
      title: "Dead-letter queues in Azure Service Bus",
      url: "https://learn.microsoft.com/en-us/azure/service-bus-messaging/service-bus-dead-letter-queues",
      publisher: "Microsoft Learn",
      kind: "docs",
      note: "Why messages are dead-lettered and how to inspect them.",
    },
  ],
};
