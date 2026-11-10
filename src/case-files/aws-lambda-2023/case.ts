import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "public",
  company: "Amazon Web Services (AWS)",
  date: "June 13, 2023",
  incidentClass: "Single-cell invocation-capacity failure in Lambda us-east-1, not a control-plane outage",
  accuracyNote:
    "Verified against AWS's public post-event summary for June 13, 2023: the 10:01 AM PDT front-end scaling, the 11:49 AM PDT threshold crossing, the latent defect that allocated execution environments without fully utilizing them, the scale-down mitigation, the 1:30 and 1:45 PM recovery milestones, the 3:37 PM backlog completion, dependent-service impact, and AWS's remediations. The report describes a single-cell invocation-capacity failure, not a Lambda control-plane outage; this file does not claim that Lambda's control plane failed. It does not disclose the defect's code, the exact threshold, server counts, or customer-level error rates, and none are asserted. What remains uncertain is whether other cells carried the same latent exposure before the fix; the report says the bug was resolved and deployed to all Regions but does not publish the validation detail.",
  timeline: [
    {
      at: "T+00:00",
      title: "The front end scales with normal daily traffic",
      body: "At 10:01 AM PDT, the Lambda front-end fleet begins scaling in response to an increase in service traffic that AWS describes as within normal daily patterns in us-east-1.",
      tone: "info",
    },
    {
      at: "T+01:48",
      title: "One cell crosses an untested threshold",
      body: "At 11:49 AM PDT, the front end crosses a capacity threshold never reached before within a single cell. A latent software defect causes execution environments to be allocated for incoming requests but never fully utilized. Invocations in that cell fail or slow, and asynchronous and streaming event sources accumulate backlog. Other cells are unaffected.",
      tone: "danger",
    },
    {
      at: "T+02:25",
      title: "Engineers identify the allocation defect",
      body: "By 12:26 PM PDT, engineers identify the latent defect and its impact on execution-environment provisioning. They confirm traffic has subsided and begin scaling the front-end fleet down below the level that triggers the defect.",
      tone: "warn",
    },
    {
      at: "T+03:29",
      title: "New invocations begin to recover",
      body: "By 1:30 PM PDT, new Lambda function invocations begin to recover as the front-end fleet returns below the triggering threshold.",
      tone: "info",
    },
    {
      at: "T+03:44",
      title: "Synchronous invocations are normal",
      body: "By 1:45 PM PDT, Lambda is fully recovered for synchronous invocations. Most affected AWS services begin to recover at this point. Asynchronous events remain queued.",
      tone: "success",
    },
    {
      at: "T+05:36",
      title: "The asynchronous backlog clears",
      body: "Between 1:45 PM and 3:37 PM PDT, Lambda processes the backlog of asynchronous events according to each event source's retry policy. By 3:37 PM, Lambda and the services that depend on it are operating normally.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "scope-classification",
      prompt: "Invocations are failing in one cell while other cells still serve traffic. What is your first classification?",
      options: [
        {
          id: "scope-cell",
          label: "Scope the failure by cell and function, keep traffic on healthy cells, and avoid a region-wide failover.",
          consequence:
            "This matches the report: other Lambda cells were unaffected. It preserves healthy capacity and avoids turning a partial failure into a regional migration event.",
          quality: "good",
        },
        {
          id: "region-down",
          label: "Declare the region down and fail all traffic to another region.",
          consequence:
            "This discards healthy capacity and adds a second load surge. The report says invocations in other cells were not affected by this event.",
          quality: "poor",
        },
        {
          id: "blame-code",
          label: "Assume the latest function deployment is the cause and roll it back.",
          consequence:
            "The trigger was front-end scaling under normal traffic, not a customer code change. A rollback adds change without addressing execution-environment allocation.",
          quality: "poor",
        },
      ],
      debrief:
        "Scope is the first diagnostic. A single-cell failure is not a regional outage, and a failed invocation is not necessarily a code failure. The report gives a precise mechanism: execution environments were allocated but never fully utilized, so the front end could not provision new ones. That is an invocation-path capacity failure. The control-plane label is a hypothesis to test, not a conclusion to announce.",
    },
    {
      id: "mitigation",
      prompt: "The defect is in the front end's use of execution environments. What is the immediate mitigation?",
      options: [
        {
          id: "scale-down",
          label: "After confirming traffic has subsided, scale the front-end fleet down below the threshold that triggers the defect.",
          consequence:
            "This matches AWS's immediate mitigation. New invocations began recovering by 1:30 PM and synchronous invocations were normal by 1:45 PM.",
          quality: "good",
        },
        {
          id: "add-capacity",
          label: "Add more front-end capacity to route around the affected cell.",
          consequence:
            "Scaling up is what crossed the threshold. More capacity can re-trigger the defect and increase the number of execution environments stuck in the bad state.",
          quality: "poor",
        },
        {
          id: "raise-concurrency",
          label: "Raise function concurrency limits so more execution environments are allowed.",
          consequence:
            "Concurrency limits govern how many environments a function may use, but the defect was in the front end's use of allocated environments. Raising a limit does not repair that path and may increase pressure.",
          quality: "mixed",
        },
      ],
      debrief:
        "The counterintuitive move is to reduce the fleet that is already failing. AWS could do that safely because traffic had subsided. The general lesson is to identify which resource crossed a tested boundary; adding more of that resource is not a fix unless the boundary itself has been revalidated.",
    },
    {
      id: "durable-control",
      prompt: "What control should prevent the next scaling threshold from becoming an outage?",
      options: [
        {
          id: "bound-cells",
          label: "Bound each cell to a tested size and alarm when execution environments are allocated but not utilized.",
          consequence:
            "This targets the gap the report describes: cellular scaling allowed a latent defect to cause impact as the affected cell scaled. It also gives an earlier signal than customer error rate.",
          quality: "good",
        },
        {
          id: "more-capacity",
          label: "Keep adding capacity and rely on retries to cover errors.",
          consequence:
            "This moves the fleet closer to the next untested threshold and leaves the latent defect in place.",
          quality: "poor",
        },
        {
          id: "disable-autoscaling",
          label: "Disable front-end autoscaling permanently.",
          consequence:
            "This avoids this trigger but removes the ability to follow normal daily demand. AWS disabled the specific scaling activities while fixing the bug, not autoscaling as a permanent policy.",
          quality: "mixed",
        },
      ],
      debrief:
        "The durable fix is a tested boundary, not a bigger fleet. Cellular architectures bound blast radius only if each cell's scaling envelope is tested and enforced. Pair the boundary with an alarm on the difference between allocated and utilized execution environments; customer error rate is a late signal.",
    },
  ],
  postmortem: [
    {
      type: "h3",
      text: "What happened",
    },
    {
      type: "p",
      text: "Lambda's front-end fleet scaled in response to normal daily traffic growth. While adding capacity, one cell crossed a threshold it had never reached before. A latent software defect caused execution environments to be allocated for incoming requests but never fully utilized. The front end could not provision new environments for those requests, so invocations in the affected cell returned errors or high latency. Asynchronous and streaming event sources built a backlog. Other Lambda cells were not affected.",
    },
    {
      type: "h3",
      text: "Why it spread",
    },
    {
      type: "list",
      items: [
        "Lambda is used by other AWS services, so failing invocations became STS, console, EKS provisioning, Amazon Connect, and EventBridge impact.",
        "Existing IAM sessions were not affected, but new SAML federation through STS was degraded.",
        "Asynchronous events stayed queued after synchronous invocations recovered, extending the customer-visible tail until 3:37 PM PDT.",
        "The defect was in the invocation path's capacity allocation; the report does not attribute the failure to customer code.",
      ],
    },
    {
      type: "h3",
      text: "What changed",
    },
    {
      type: "list",
      items: [
        "AWS disabled the front-end scaling activities that triggered the event while it fixed the latent bug.",
        "The bug was resolved and deployed to all Regions.",
        "AWS completed several immediate action items for cellular scaling and said it remained on track to complete a larger effort to bound all cells to a well-tested size.",
        "The report says the larger cellular-scaling effort was planned for later that year.",
      ],
    },
    {
      type: "h3",
      text: "What generalizes",
    },
    {
      type: "p",
      text: "The question is not whether a service is up. It is which operation, in which scope, is failing. Existing functions in healthy cells kept working while invocations in one cell failed, so a binary status answer would have been misleading in both directions. A capacity threshold that has never been reached is still a production limit. Telemetry should compare allocated execution environments with utilized ones, not just count errors after customers see them.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Framing note",
      body: "The title uses control plane as a provocation. The public report does not describe a Lambda control-plane outage. It describes a latent defect in the invocation path's execution-environment allocation, triggered by front-end scaling in one cell. The transferable lesson is to identify the plane and scope that own the failing operation before declaring the service up or down.",
    },
  ],
  sources: [
    {
      title: "Summary of the AWS Lambda Service Event in Northern Virginia (US-EAST-1) Region",
      url: "https://aws.amazon.com/message/061323/",
      publisher: "Amazon Web Services",
      kind: "postmortem",
      note: "Official post-event summary: scaling trigger, latent allocation defect, mitigation, recovery, and remediation.",
    },
    {
      title: "Lambda quotas",
      url: "https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html",
      publisher: "Amazon Web Services",
      kind: "docs",
      note: "Invocation, concurrency, and execution-environment limits.",
    },
    {
      title: "Understanding Lambda function scaling",
      url: "https://docs.aws.amazon.com/lambda/latest/dg/lambda-concurrency.html",
      publisher: "Amazon Web Services",
      kind: "docs",
      note: "How concurrency and execution environments scale with demand.",
    },
  ],
};
