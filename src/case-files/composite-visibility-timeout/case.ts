import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Duplicate message processing after a visibility timeout mismatch",
  accuracyNote:
    "This is an original composite, not a real company incident. It is not a real incident and does not describe any organization's architecture, dates, traffic, people, or internal decisions. It combines common queue, timeout, and idempotency failure modes; all times are relative and all telemetry is illustrative.",
  architecture: { id: "request-path" },
  timeline: [
    {
      at: "T+00:00",
      title: "A slow dependency joins the handler",
      body: "The consumer adds a synchronous risk check before writing its result. Median processing time barely moves, but the tail rises from seconds to tens of seconds for a minority of messages.",
      tone: "info",
    },
    {
      at: "T+00:05",
      title: "The visibility timeout stays put",
      body: "The queue still uses the timeout chosen for the old, faster handler. No heartbeat or extension is configured, so a message becomes visible again while the first attempt is still working.",
      tone: "warn",
    },
    {
      at: "T+00:12",
      title: "Messages reappear",
      body: "Slow messages are delivered to a second consumer. Duplicate work begins, and the receive count for the affected messages climbs as the queue counts each delivery.",
      tone: "warn",
    },
    {
      at: "T+00:18",
      title: "A duplicate side effect",
      body: "The handler writes a charge without a conditional write or idempotency key. A small number of customers are charged twice, while most duplicates only waste compute.",
      tone: "danger",
    },
    {
      at: "T+00:30",
      title: "Backlog feeds the loop",
      body: "Duplicate work adds load, which slows processing further, which produces more redeliveries. The dead-letter queue begins to fill with messages that exhausted their receive limit.",
      tone: "danger",
    },
    {
      at: "T+00:45",
      title: "The timeout is implicated",
      body: "The team compares the processing-time distribution with the configured timeout and inspects receive counts. The overlap between slow success and redelivery is unambiguous.",
      tone: "info",
    },
    {
      at: "T+01:00",
      title: "Writes become idempotent first",
      body: "The handler starts writing with a key derived from the message and a conditional check. Duplicate attempts return the original result instead of creating a second charge.",
      tone: "warn",
    },
    {
      at: "T+01:30",
      title: "Visibility is extended and raised",
      body: "Long handlers extend visibility with a heartbeat, and the queue timeout is raised above the observed p99.9 with margin. Both changes roll out together.",
      tone: "success",
    },
    {
      at: "T+03:00",
      title: "Backlog drains",
      body: "Duplicate deliveries fall to near zero and the dead-letter queue is reviewed. A small set of double charges is queued for reversal and customer communication.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "diagnose",
      prompt: "The same message is being processed more than once. What do you check first?",
      options: [
        {
          id: "timeout-vs-duration",
          label: "Compare the processing-time distribution with the visibility timeout and inspect receive counts.",
          consequence:
            "The slow tail is clearly longer than the timeout, and the receive counts confirm redelivery rather than a publisher bug. The team can fix the timeout with evidence instead of guessing.",
          quality: "good",
        },
        {
          id: "scale-consumers",
          label: "Add consumers so the backlog clears faster.",
          consequence:
            "More consumers increase throughput, but slow messages still exceed the timeout and are still redelivered. Duplicate work scales with the consumer count, and the side-effect risk remains.",
          quality: "mixed",
        },
        {
          id: "batch-size",
          label: "Increase the batch size to reduce receive overhead.",
          consequence:
            "Larger batches make each handler slower and increase the chance that a message exceeds visibility. The change can make the duplicate rate worse.",
          quality: "poor",
        },
      ],
      debrief:
        "Duplicate delivery is normal in at-least-once systems; duplicate effects are not. The diagnostic question is whether processing time exceeds the visibility window, including the slow tail. Receive counts and message age tell you that the queue redelivered, while handler logs tell you what the first attempt was doing when the second one started.",
    },
    {
      id: "immediate",
      prompt: "Duplicates are already in flight and some have caused double writes. What comes first?",
      options: [
        {
          id: "idempotency",
          label: "Make the write idempotent and extend visibility for long-running handlers.",
          consequence:
            "New attempts can no longer create a second effect, and in-flight work gets enough time to finish. The fix protects the side effect while the queue configuration is corrected.",
          quality: "good",
        },
        {
          id: "raise-timeout",
          label: "Raise the queue timeout globally and redeploy as the first action.",
          consequence:
            "The direction is right, but the deploy takes time and does nothing for messages already being duplicated. Double writes can continue during the rollout.",
          quality: "mixed",
        },
        {
          id: "purge-dlq",
          label: "Delete the duplicate messages from the dead-letter queue.",
          consequence:
            "The visible backlog shrinks, but the underlying timeout still causes redelivery and the lost messages may include legitimate failures. The side-effect risk is untouched.",
          quality: "poor",
        },
      ],
      debrief:
        "There are two separate problems: the window is too short, and the handler is not safe when a message is delivered twice. The second is more urgent because it causes irreversible effects. Idempotency at the write boundary is the backstop that makes every other timeout change safe to roll out gradually.",
    },
    {
      id: "lasting-control",
      prompt: "What policy keeps visibility and side effects correct as processing time varies?",
      options: [
        {
          id: "heartbeat-keys",
          label: "Set timeout above p99.9, extend visibility with a heartbeat, and retain idempotency keys beyond the retry window.",
          consequence:
            "Slow messages keep their lease while they work, and any duplicate that still occurs is harmless. The key retention window covers the longest realistic redelivery path.",
          quality: "good",
        },
        {
          id: "max-timeout",
          label: "Set the timeout to the maximum possible processing time for every message.",
          consequence:
            "The timeout is safe but very long, so a crashed consumer blocks redelivery for that entire period. Throughput and recovery both suffer for a tail case that a heartbeat handles better.",
          quality: "mixed",
        },
        {
          id: "no-retries",
          label: "Disable redelivery and fail permanently on the first timeout.",
          consequence:
            "Duplicates disappear, but so does recovery from ordinary crashes and transient failures. Messages are lost or parked, and availability falls for reasons unrelated to the original bug.",
          quality: "poor",
        },
      ],
      debrief:
        "The timeout must cover the work, but a single global value cannot track variable duration. A heartbeat extends the lease while progress is real, and a timeout above p99.9 covers the gap between heartbeats. Idempotency keys with retention longer than the maximum retry window are what make duplicates a performance problem instead of a correctness problem.",
    },
  ],
  postmortem: [
    { type: "h3", text: "What happened" },
    {
      type: "p",
      text: "A new synchronous dependency lengthened the slow tail of message processing. The queue's visibility timeout still matched the old handler, so slow messages became visible while their first attempt was running. Redelivery created duplicate work, and a non-idempotent write charged a small number of customers twice.",
    },
    { type: "h3", text: "Why it compounded" },
    {
      type: "list",
      items: [
        "The visibility timeout was chosen once and never revisited when handler behavior changed.",
        "No heartbeat extended the lease for long-running work.",
        "The write path had no idempotency key, so a duplicate delivery became a duplicate effect.",
        "Receive count was not alerted, so redelivery was invisible until customers reported charges.",
      ],
    },
    { type: "h3", text: "What changed" },
    {
      type: "list",
      items: [
        "Visibility timeout is set above p99.9 processing time with an explicit safety margin.",
        "Long handlers extend their lease with a heartbeat while they make progress.",
        "Writes use idempotency keys retained longer than the maximum retry window.",
        "Alerts cover receive count, message age, and dead-letter growth.",
      ],
    },
    { type: "h3", text: "What generalizes" },
    {
      type: "p",
      text: "At-least-once delivery means duplicates are part of normal operation, not an exception. The visibility timeout is a lease on work, and it must be longer than the work or extended while the work continues. Idempotency is the only reliable protection for side effects, because no timeout policy can prevent every duplicate during a crash or a network partition.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, rates, and queue observations in this file are illustrative. They describe a composite scenario, not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "Amazon SQS visibility timeout",
      url: "https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html",
      publisher: "Amazon SQS",
      kind: "docs",
      note: "Lease behavior, extension, and redelivery.",
    },
    {
      title: "At-least-once delivery",
      url: "https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues-at-least-once-delivery.html",
      publisher: "Amazon SQS",
      kind: "docs",
      note: "Why standard queues can deliver a message more than once.",
    },
    {
      title: "Amazon SQS message lifecycle",
      url: "https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-message-lifecycle.html",
      publisher: "Amazon SQS",
      kind: "docs",
      note: "Receive count, visibility, retention, and dead-letter queues.",
    },
    {
      title: "Making retries safe with idempotent APIs",
      url: "https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/",
      publisher: "AWS Builders' Library",
      kind: "docs",
      note: "Idempotency keys and duplicate side-effect prevention.",
    },
  ],
};
