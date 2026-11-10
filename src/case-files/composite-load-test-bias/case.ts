import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Capacity certification based on a closed-loop load test",
  accuracyNote:
    "This is an original composite scenario, not a real incident. It combines common load-testing measurement errors into one representative capacity decision. It is not a real company incident and does not describe any organization's architecture, traffic, dates, or internal decisions. All times and telemetry are illustrative.",
  architecture: { id: "request-path" },
  timeline: [
    {
      at: "T-21d",
      title: "A capacity number is promised",
      body: "A launch plan commits to peak traffic of 20k requests per second. Engineering must certify that the service and its dependencies can hold that rate with latency inside the SLO.",
      tone: "info",
    },
    {
      at: "T-14d",
      title: "The closed-loop test passes",
      body: "The load generator runs 300 workers. Each worker sends one request, waits for the response, then sends the next. The report shows 20k RPS and a p99 of 210ms, so the service is marked ready.",
      tone: "success",
    },
    {
      at: "T-0 12:00",
      title: "Production reaches 12k RPS",
      body: "Traffic climbs on schedule. At 12k RPS, p99 crosses two seconds, request queues grow, and the edge starts returning 5xx. The service is well below the certified number.",
      tone: "warn",
    },
    {
      at: "T+00:20",
      title: "Autoscaling adds capacity",
      body: "The service scales out, but latency does not improve. The bottleneck is a shared dependency connection pool that the test environment never exercised at the same concurrency.",
      tone: "danger",
    },
    {
      at: "T+00:55",
      title: "The generator history explains the gap",
      body: "During multi-second stalls, each worker waited and issued no new request. The intended arrival rate was never offered, and the slow requests that did occur were a small share of the samples used for p99.",
      tone: "danger",
    },
    {
      at: "T+02:00",
      title: "An open-loop replay finds the knee",
      body: "The team reruns with requests scheduled at a fixed arrival rate, independent of responses. The corrected p99 at 12k RPS is above three seconds, and the knee appears near 9k RPS.",
      tone: "info",
    },
    {
      at: "T+03:10",
      title: "The launch is paused",
      body: "The rollout is stopped and the capacity target is re-baselined against the open-loop result. No new code is blamed; the measurement method was the defect.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "trust-the-result",
      prompt: "The test certified 20k RPS, but production is failing at 12k. What is the first move?",
      options: [
        {
          id: "pause-and-rerun",
          label: "Pause the rollout and rerun the test with an open-loop arrival schedule.",
          consequence:
            "The team stops adding load to a failing system and reproduces the production condition. The rerun shows the real knee and gives a defensible basis for the launch decision.",
          quality: "good",
        },
        {
          id: "add-capacity",
          label: "Add 40% more capacity to cover the gap, then continue the rollout.",
          consequence:
            "The service may survive the next hour, but the team still does not know which resource saturates or whether the test can be trusted for the next launch. Cost rises without a corrected model.",
          quality: "mixed",
        },
        {
          id: "blame-traffic",
          label: "Treat production traffic as unrepresentative and keep the certified target.",
          consequence:
            "The launch proceeds against a number the system cannot sustain. The gap between test and production becomes a recurring disagreement rather than a diagnosed measurement error.",
          quality: "poor",
        },
      ],
      debrief:
        "A passing test is evidence only if it offered the same demand the production system will see. When the two disagree, the priority is to reproduce the disagreement, not to add capacity around it. Pausing the rollout also protects the system while the measurement is corrected.",
    },
    {
      id: "find-the-bias",
      prompt: "Where did the test understate latency?",
      options: [
        {
          id: "request-schedule",
          label: "The generator waited for responses, so stalls reduced the request rate and removed slow samples.",
          consequence:
            "The team identifies coordinated omission: latency was measured only for requests the generator chose to send. Scheduling arrivals independently of completions exposes the missing delay.",
          quality: "good",
        },
        {
          id: "warm-caches",
          label: "The test environment had warmer caches and should be restarted between runs.",
          consequence:
            "Cache state matters, but it does not explain why a stalled generator would report a low tail. The team may spend days tuning the environment while the sampling error remains.",
          quality: "mixed",
        },
        {
          id: "more-workers",
          label: "The generator needed more workers to reach the target rate.",
          consequence:
            "More workers can increase throughput, but they also change the closed-loop feedback. The reported percentile remains conditional on response completion, so the bias persists.",
          quality: "poor",
        },
      ],
      debrief:
        "A closed-loop generator treats a slow response as a reason to send less traffic. That is useful for testing a fixed concurrency limit, but it is the wrong model for an arrival-rate SLO. Coordinated-omission correction, or an open-loop generator, accounts for the requests that should have been sent while the system was stalled.",
    },
    {
      id: "lasting-gate",
      prompt: "What should certify capacity before the next launch?",
      options: [
        {
          id: "open-loop-gate",
          label:
            "Use production traffic mix, an open-loop arrival schedule, corrected tail latency, and the full dependency path as the gate.",
          consequence:
            "The test exercises the same demand shape and bottlenecks that production will expose. A failed gate now means the service is not ready, rather than that the generator needs tuning.",
          quality: "good",
        },
        {
          id: "longer-test",
          label: "Run the existing closed-loop test for a longer period.",
          consequence:
            "A longer run may find a slow leak, but it does not fix the request schedule. The same stall can still hide the tail, and the team gains confidence without gaining evidence.",
          quality: "mixed",
        },
        {
          id: "safety-factor",
          label: "Keep the closed-loop result and divide the certified capacity by two.",
          consequence:
            "The arbitrary margin may cover this gap, but it hides the cause and misstates capacity for every future workload. The team cannot explain the number or improve the test.",
          quality: "poor",
        },
      ],
      debrief:
        "The durable fix is a test design, not a discount on the result. Open-loop arrivals preserve the intended request rate, corrected percentiles include stalled time, and the dependency path must match production. The gate should also record the traffic mix and data shape so a future change cannot silently invalidate the result.",
    },
  ],
  postmortem: [
    {
      type: "h3",
      text: "What happened",
    },
    {
      type: "p",
      text: "A closed-loop generator was used to certify an arrival-rate target. When the service stalled, the generator stalled with it, so the test never offered the intended load and never recorded most of the delay. Production offered a steady arrival rate and found the real knee at roughly 9k RPS.",
    },
    {
      type: "h3",
      text: "What made it worse",
    },
    {
      type: "list",
      items: [
        "The test reported throughput and a percentile but not the offered request schedule.",
        "The test environment used a smaller dependency pool, so the first shared bottleneck was absent.",
        "Cached data and a short run hid queue growth that production would accumulate.",
        "No one compared the test's arrival rate with the production load model during review.",
      ],
    },
    {
      type: "h3",
      text: "What changed",
    },
    {
      type: "list",
      items: [
        "Capacity tests use open-loop arrivals with production traffic mix and data shape.",
        "Tail latency is computed with coordinated-omission correction and reported beside throughput.",
        "The gate fails if p99 exceeds the SLO at the target rate, even when average latency looks healthy.",
        "A pre-launch check compares dependency concurrency and pool limits between test and production.",
      ],
    },
    {
      type: "h3",
      text: "What generalizes",
    },
    {
      type: "p",
      text: "A load test measures a system and a generator together. If the generator slows down when the system slows down, the result describes a closed loop, not the demand a production client will create. Capacity numbers need an explicit arrival model, a corrected tail, and the same bottlenecks the real path contains.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All rates, percentiles, and timings in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "How NOT to Measure Latency",
      url: "https://www.infoq.com/presentations/latency-response-time/",
      publisher: "InfoQ",
      kind: "talk",
      note: "Coordinated omission, closed-loop measurement, and corrected latency reporting.",
    },
    {
      title: "wrk2: a constant-throughput HTTP benchmarking tool",
      url: "https://github.com/giltene/wrk2",
      publisher: "Gil Tene",
      kind: "docs",
      note: "Open-loop request generation with corrected latency histograms.",
    },
    {
      title: "Constant arrival rate executor",
      url: "https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/constant-arrival-rate/",
      publisher: "Grafana k6",
      kind: "docs",
      note: "Scheduling requests at a fixed rate independently of responses.",
    },
    {
      title: "HdrHistogram",
      url: "https://github.com/HdrHistogram/HdrHistogram",
      publisher: "HdrHistogram Project",
      kind: "docs",
      note: "High-dynamic-range latency recording used for tail analysis.",
    },
  ],
};
