import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "public",
  company: "Amazon Web Services (AWS)",
  date: "November 25, 2020",
  incidentClass: "Front-end fleet thread exhaustion and dependent-service blast radius in Kinesis us-east-1",
  accuracyNote:
    "Verified against AWS's public post-event summary for November 25, 2020: the 2:44-3:47 AM PST capacity addition, the 5:15 AM alarms, the 9:39 AM thread-limit root cause, the 10:07 AM restart, the 10:23 PM full recovery, the dependent-service impacts, and AWS's stated remediations. The report does not disclose the exact thread limit, server counts, customer request rates, or the internal change that added capacity, so none are asserted here. What remains uncertain is whether other fleet-size-coupled limits exist beyond those AWS names; the report does not enumerate them. Relative times are derived from the report's PST milestones; durations that the report gives only approximately are described as approximate. No quotation is attributed to an individual.",
  timeline: [
    {
      at: "T+00:00",
      title: "A small front-end capacity addition begins",
      body: "At 2:44 AM PST, AWS begins adding a relatively small amount of capacity to the Kinesis front-end fleet. The front end handles authentication, throttling, and request routing. Each front-end server caches a shard-map built from a membership microservice, DynamoDB configuration, and messages from other front-end servers.",
      tone: "info",
    },
    {
      at: "T+01:03",
      title: "Existing servers begin learning the new peers",
      body: "The addition finishes at 3:47 AM PST. Existing front-end members learn about new participants and create operating-system threads for each of them. The report says it can take up to an hour for an existing member to learn about new participants.",
      tone: "warn",
    },
    {
      at: "T+02:31",
      title: "Put and get alarms fire",
      body: "At 5:15 AM PST, the first alarms fire for errors putting and getting Kinesis records. New capacity is a suspect, but the team also sees errors unrelated to it. As a precaution, AWS begins removing the added capacity while it investigates.",
      tone: "danger",
    },
    {
      at: "T+05:07",
      title: "The likely fixes all require a full restart",
      body: "At 7:51 AM PST, the team narrows the cause to a few candidates. Each likely fix requires changing every front-end server's configuration and restarting it. A restart is known to be long and careful because shard-map construction competes with request processing.",
      tone: "warn",
    },
    {
      at: "T+06:55",
      title: "The thread limit is confirmed",
      body: "At 9:39 AM PST, AWS confirms the added capacity pushed every front-end server past an operating-system thread limit. Shard-map construction failed, leaving servers with useless maps and no ability to route requests. With the added capacity already removed, the thread count is back under the limit, and the team proceeds with the restart.",
      tone: "danger",
    },
    {
      at: "T+07:23",
      title: "Traffic returns in small batches",
      body: "The first group of front-end servers takes Kinesis traffic at 10:07 AM PST. The fleet has many thousands of servers, and AWS can add only a few hundred per hour without recreating the cold-start contention that would make servers look unhealthy.",
      tone: "info",
    },
    {
      at: "T+19:39",
      title: "Kinesis returns to normal",
      body: "Kinesis fully returns to normal at 10:23 PM PST. The error rate had fallen steadily from noon onward. Dependent services recovered on their own schedules, some after Kinesis itself was healthy.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "first-move",
      prompt: "Kinesis put and get errors are rising, and dependent services are already failing. What is the first move?",
      options: [
        {
          id: "remove-capacity",
          label: "Stop and reverse the capacity addition while separating new errors from errors that predate it.",
          consequence:
            "This removes the trigger and prevents the thread count from rising further. It does not repair shard-maps that were already built incorrectly, so the team still has to find the root cause and restart.",
          quality: "good",
        },
        {
          id: "add-capacity",
          label: "Add more front-end servers to replace the unhealthy ones.",
          consequence:
            "Each new server increases the thread count across the fleet and can push more servers past the limit. It treats a capacity shortage as the cause when the limit is the constraint.",
          quality: "poor",
        },
        {
          id: "restart-blind",
          label: "Restart the entire front-end fleet immediately, before the cause is confirmed.",
          consequence:
            "A restart may clear the bad shard-maps, but the report says several candidate fixes were still possible. A wrong guess would require a second full restart and roughly double the recovery time.",
          quality: "mixed",
        },
      ],
      debrief:
        "The report calls the capacity addition a trigger, not the root cause. Removing it was necessary but not sufficient. A first responder should stop the change, preserve evidence, and avoid adding capacity into a limit that has already been exceeded. The hard part is separating the trigger from unrelated errors that would persist either way.",
    },
    {
      id: "restart-pace",
      prompt: "The fleet needs a restart. How do you bring it back?",
      options: [
        {
          id: "slow-batches",
          label: "Restart in small batches and bootstrap shard-maps from the authoritative metadata store instead of neighbor servers.",
          consequence:
            "This matches the documented recovery: first traffic at 10:07 AM, a few hundred servers per hour, error rate falling from noon, full recovery at 10:23 PM. The parallel configuration change reduced dependence on fleet-wide chatter.",
          quality: "good",
        },
        {
          id: "all-at-once",
          label: "Restart all front-end servers at once so the fleet reaches a consistent state quickly.",
          consequence:
            "Shard-map construction competes with request processing. Returning too fast leaves few resources for requests, servers look unhealthy, and removals set the recovery back.",
          quality: "poor",
        },
        {
          id: "raise-limit",
          label: "Raise the operating-system thread limit immediately and skip the restart.",
          consequence:
            "AWS declined to raise the limit without further testing. It might create headroom, but it does not repair servers already holding useless shard-maps and could introduce a new untested limit.",
          quality: "mixed",
        },
      ],
      debrief:
        "Slow is fast when the bootstrap path competes with the serving path. The restart rate is a capacity control, not just a deployment preference. Reading metadata from the authoritative store is the more durable fix because it removes a fleet-wide gossip dependency from cold start.",
    },
    {
      id: "dependent-isolation",
      prompt: "Cognito is failing because its Kinesis buffers are full. What should the dependent service do?",
      options: [
        {
          id: "buffer-and-decouple",
          label: "Add temporary buffer capacity, then change the service so Kinesis errors cannot block request handling.",
          consequence:
            "Cognito did both: it added capacity early, then deployed a change to reduce reliance on Kinesis. Its error rates fell by 12:15 PM and it was operating normally by 2:18 PM.",
          quality: "good",
        },
        {
          id: "wait-for-kinesis",
          label: "Keep serving requests and wait for Kinesis to recover.",
          consequence:
            "Cognito's local buffers filled. A latent bug made webservers block on the backlog, turning a best-effort telemetry path into authentication failures.",
          quality: "poor",
        },
        {
          id: "remove-stream",
          label: "Remove all Kinesis usage from the service.",
          consequence:
            "It eliminates this dependency but may discard useful operational data. The report's fix is to sustain Kinesis errors without exhausting buffers, not to remove the stream.",
          quality: "mixed",
        },
      ],
      debrief:
        "A best-effort dependency is only best-effort if the caller implements a bounded, fail-open path. Buffers without a drop policy become a queue that eventually blocks the request thread. The test is not whether the dependency is labeled best-effort; it is what the caller does when the buffer is full.",
    },
  ],
  postmortem: [
    {
      type: "h3",
      text: "What happened",
    },
    {
      type: "p",
      text: "AWS added a small amount of capacity to the Kinesis front-end fleet. Each existing front-end server maintained operating-system threads for every other front-end server, so the addition increased the thread count across the fleet. The fleet crossed a limit in its operating-system configuration. Shard-map construction failed, servers could not route requests, and a full front-end restart was required. The restart was slow because shard-map population competes with request processing and the fleet could only absorb a few hundred servers per hour.",
    },
    {
      type: "h3",
      text: "Why it spread",
    },
    {
      type: "list",
      items: [
        "Kinesis is used by other AWS services, so a front-end routing failure propagated into authentication and monitoring failures, event-delivery delays, and container-management impact.",
        "Cognito's buffers were designed for short Kinesis unavailability, but a latent bug made webservers block when the backlog persisted.",
        "CloudWatch saw elevated errors and latency for metric and log ingestion, alarms moved to INSUFFICIENT_DATA, and services that autoscale on those metrics were delayed.",
        "Lambda buffered metric data locally until memory contention increased invocation errors.",
      ],
    },
    {
      type: "h3",
      text: "What changed",
    },
    {
      type: "list",
      items: [
        "AWS planned to move to larger CPU and memory servers so the fleet needs fewer servers and fewer threads per server.",
        "It began adding fine-grained alarms for thread consumption and began testing a higher operating-system thread limit.",
        "It outlined cold-start improvements, moving the front-end cache to a dedicated fleet, and separating a large service such as CloudWatch onto a partitioned front-end fleet.",
        "It planned to accelerate cellularization of the front end so each cell stays within a tested range.",
      ],
    },
    {
      type: "h3",
      text: "What generalizes",
    },
    {
      type: "p",
      text: "A managed service still has finite internal limits, and some limits scale with fleet size rather than with customer request rate. That makes them easy to miss during normal growth. The incident also shows why removing the trigger is not the same as recovery: the bad state persisted in the shard-maps until the fleet was restarted. Dependents need a bounded fail-open path, not just a label that says the dependency is best-effort.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Verified scope",
      body: "The capacity window, alarm time, thread-limit cause, restart pace, recovery time, dependent-service impacts, and remediation items above come from the AWS post-event summary. Exact server counts, thread limits, and customer request rates are not disclosed in that report and are omitted here. Dependents' recovery times are those stated in the report.",
    },
  ],
  sources: [
    {
      title: "Summary of the Amazon Kinesis Event in the Northern Virginia (US-EAST-1) Region",
      url: "https://aws.amazon.com/message/11201/",
      publisher: "Amazon Web Services",
      kind: "postmortem",
      note: "Official post-event summary: trigger, thread-limit root cause, restart, dependent impact, and remediation.",
    },
    {
      title: "Amazon Kinesis Data Streams quotas and limits",
      url: "https://docs.aws.amazon.com/streams/latest/dev/service-sizes-and-limits.html",
      publisher: "Amazon Web Services",
      kind: "docs",
      note: "Managed throughput and request limits that bound stream capacity.",
    },
    {
      title: "Implement graceful degradation to transform failures into useful behavior",
      url: "https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/rel_mitigate_interaction_failure_graceful_degradation.html",
      publisher: "AWS Well-Architected Framework",
      kind: "standard",
      note: "Bounded failure handling for dependencies and degraded modes.",
    },
  ],
};
