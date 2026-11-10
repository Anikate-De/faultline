import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Reactive autoscaling against a short traffic ramp",
  accuracyNote:
    "This is an original composite scenario, not a real incident. It combines common autoscaling, cold-start, and scale-in behaviors into one representative capacity event. It is not a real company incident and does not describe any organization's architecture, traffic, dates, or internal decisions. All times and telemetry are illustrative.",
  architecture: { id: "request-path" },
  timeline: [
    {
      at: "T-02:00",
      title: "A promotion starts moving traffic",
      body: "A scheduled campaign lifts request volume to four times baseline within four minutes. The increase is real demand, but it is concentrated in a short window rather than a gradual daily ramp.",
      tone: "info",
    },
    {
      at: "T+00:00",
      title: "Target tracking reacts",
      body: "The autoscaler sees average CPU at 85% against a 60% target. Its policy requires a sustained breach over a one-minute window before it changes desired capacity.",
      tone: "warn",
    },
    {
      at: "T+01:30",
      title: "Scale-out is requested",
      body: "Desired count rises by twelve tasks. The scheduler places them, but each task must pull an image, initialize a runtime, warm a local cache, and pass a readiness check before it receives traffic.",
      tone: "warn",
    },
    {
      at: "T+05:30",
      title: "The first new tasks become ready",
      body: "Measured time from placement to serving traffic is just over four minutes. By now the promotion peak has passed, and the original fleet has already absorbed the latency hit.",
      tone: "danger",
    },
    {
      at: "T+06:00",
      title: "The spike ends",
      body: "Traffic falls back toward 1.5 times baseline. The twelve new tasks are healthy but mostly idle, and the service is now paying for capacity that no longer matches demand.",
      tone: "info",
    },
    {
      at: "T+09:00",
      title: "Scale-in waits",
      body: "A cooldown prevents immediate removal, so the oversized fleet remains for several more minutes. The p99 SLO has been burned for roughly twenty minutes, much of it after the peak.",
      tone: "warn",
    },
    {
      at: "T+40:00",
      title: "The policy is re-examined",
      body: "The review finds that the autoscaler was tuned for average load and startup was treated as a fixed property of the platform. No one had measured the time from scale-out decision to first served request.",
      tone: "info",
    },
  ],
  decisions: [
    {
      id: "first-move",
      prompt: "Latency is climbing, traffic is still rising, and new tasks are minutes away. What do you do first?",
      options: [
        {
          id: "warm-capacity",
          label: "Manually add warm capacity and shed low-priority traffic until the ramp is covered.",
          consequence:
            "The service gains serving capacity before the autoscaler can react, and load shedding protects the SLO for critical requests. The manual action buys time to fix the policy rather than waiting on it.",
          quality: "good",
        },
        {
          id: "raise-max",
          label: "Raise the maximum task count and let the existing policy handle the ramp.",
          consequence:
            "The ceiling was not the binding constraint; startup time was. The policy still reacts late, and the larger fleet arrives after the peak, increasing cost without protecting latency.",
          quality: "mixed",
        },
        {
          id: "lower-target",
          label: "Lower the CPU target so the autoscaler reacts earlier next time.",
          consequence:
            "An earlier trigger helps at the margin, but it does not create capacity faster. It also keeps the fleet at a higher baseline, paying for idle headroom without addressing short ramps.",
          quality: "mixed",
        },
      ],
      debrief:
        "During the incident, the goal is to add serving capacity now, not to tune a feedback loop that is already behind. Warm capacity and load shedding act inside the ramp. The policy change comes afterward, informed by the measured startup time and the shape of the demand curve.",
    },
    {
      id: "policy-design",
      prompt: "What scaling policy would have covered this ramp?",
      options: [
        {
          id: "predictive-plus-warm",
          label:
            "Combine a leading-indicator forecast with a warm minimum pool sized to the startup delay.",
          consequence:
            "Capacity begins before the demand arrives, and the minimum pool covers the interval when reactive scaling cannot help. The policy is explicit about the ramp shapes it can and cannot absorb.",
          quality: "good",
        },
        {
          id: "scheduled-only",
          label: "Replace target tracking with a fixed schedule based on the campaign calendar.",
          consequence:
            "The known campaign is covered, but unplanned ramps and schedule changes are not. A calendar is a useful input, not a complete policy for variable demand.",
          quality: "mixed",
        },
        {
          id: "bigger-tasks",
          label: "Use larger tasks so fewer of them need to start.",
          consequence:
            "Fewer starts reduce scheduling overhead, but each start still takes minutes and the fleet becomes coarser. Burst capacity is less flexible and the cost floor rises.",
          quality: "poor",
        },
      ],
      debrief:
        "A reactive policy cannot beat a startup delay it does not model. Predictive scaling on a leading signal starts the work earlier, while a warm pool covers the gap between decision and readiness. The minimum should be derived from measured startup time and the fastest credible ramp, not from an annual average.",
    },
    {
      id: "scale-in",
      prompt: "The spike is over and the new tasks are idle. How should scale-in behave?",
      options: [
        {
          id: "cooldown-floor",
          label: "Use a cooldown, a minimum floor, and gradual removal while watching latency.",
          consequence:
            "The fleet avoids flapping on a noisy signal and keeps enough warm capacity for a second wave. Cost falls predictably instead of oscillating with every short dip.",
          quality: "good",
        },
        {
          id: "immediate",
          label: "Remove all extra tasks as soon as CPU falls below target.",
          consequence:
            "Cost drops quickly, but a small second spike can exhaust the remaining fleet while replacements start. The policy trades availability for a short-term saving.",
          quality: "poor",
        },
        {
          id: "no-scale-in",
          label: "Disable scale-in so the fleet never has to start tasks again.",
          consequence:
            "The service keeps peak capacity indefinitely. That removes cold starts at the cost of paying for the maximum all month, which is not viable for variable demand.",
          quality: "poor",
        },
      ],
      debrief:
        "Scale-in is part of the same control loop as scale-out. Removing capacity too quickly creates a new cold start on the next small spike; removing it too slowly turns a transient peak into a permanent cost floor. A cooldown plus a measured warm minimum balances both risks.",
    },
  ],
  postmortem: [
    {
      type: "h3",
      text: "What happened",
    },
    {
      type: "p",
      text: "A short promotion ramp arrived faster than the autoscaler could react. The policy waited for a sustained CPU breach, then requested tasks that needed several minutes to become ready. By the time they served traffic, the peak had passed, leaving the service with a latency burn and an idle fleet.",
    },
    {
      type: "h3",
      text: "What made it worse",
    },
    {
      type: "list",
      items: [
        "The scaling signal was a lagging average that reacted after the ramp was visible to users.",
        "Startup time was not measured from scale-out decision to first served request.",
        "The readiness check covered process health, not cache warm-up or dependency connection setup.",
        "The scale-in cooldown was tuned for cost, not for the possibility of a second ramp.",
      ],
    },
    {
      type: "h3",
      text: "What changed",
    },
    {
      type: "list",
      items: [
        "A warm minimum pool covers the measured startup interval for the critical service.",
        "Predictive scaling uses a leading request-rate signal and the campaign calendar as inputs.",
        "Readiness includes a small warm-up request path before a task joins the load balancer.",
        "Scale-in uses a cooldown and gradual removal, with latency and queue depth as guardrails.",
      ],
    },
    {
      type: "h3",
      text: "What generalizes",
    },
    {
      type: "p",
      text: "Autoscaling has a deadline problem. A policy that reacts in one minute is still too slow if a new task needs four minutes to serve traffic and the ramp lasts five. Capacity planning for variable demand must measure startup latency, model the ramp, and keep a warm floor for the part of the curve that feedback cannot reach.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, multipliers, and utilization values in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "Horizontal Pod Autoscaling",
      url: "https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/",
      publisher: "Kubernetes",
      kind: "docs",
      note: "Reactive scaling behavior, stabilization windows, and tolerance.",
    },
    {
      title: "Amazon ECS service auto scaling",
      url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-auto-scaling.html",
      publisher: "Amazon Web Services",
      kind: "docs",
      note: "Target tracking, cooldowns, and task-level scaling controls.",
    },
    {
      title: "Managing Load",
      url: "https://sre.google/workbook/managing-load/",
      publisher: "Google SRE Workbook",
      kind: "book",
      note: "Load management, capacity, and overload response.",
    },
    {
      title: "KEDA scaling concepts",
      url: "https://keda.sh/docs/2.17/concepts/scaling-deployments/",
      publisher: "KEDA",
      kind: "docs",
      note: "Event-driven scaling, scale-to-zero, and cold-start tradeoffs.",
    },
  ],
};
