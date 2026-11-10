import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Telemetry pipeline failure during a user-facing incident",
  accuracyNote:
    "This is an original composite, not a real company incident. It is not a real incident and does not describe any organization's architecture, dates, traffic, people, or internal decisions. It combines common agent, pipeline, and alerting failure modes; all times are relative and all telemetry is illustrative.",
  architecture: { id: "request-path" },
  timeline: [
    {
      at: "T+00:00",
      title: "A cost-reduction rollout starts",
      body: "The platform team ships a new collector configuration: a different remote-write destination, larger batches, and a tighter memory limit to reduce telemetry spend.",
      tone: "info",
    },
    {
      at: "T+00:10",
      title: "Collectors begin restarting",
      body: "The new batch size exceeds what the memory limit can hold. Collector processes are killed and restart repeatedly, buffering briefly and then dropping data.",
      tone: "warn",
    },
    {
      at: "T+00:18",
      title: "Dashboards freeze",
      body: "Panels keep displaying their last values, which look normal. Alert rules receive no samples, and because they are not configured to treat absence as a problem, they stay in the OK state.",
      tone: "warn",
    },
    {
      at: "T+00:25",
      title: "A real deploy fails",
      body: "A checkout release raises errors at the edge. The service is genuinely unhealthy, but the request-rate, error, and latency panels have nothing new to show.",
      tone: "danger",
    },
    {
      at: "T+00:40",
      title: "Users report the failure first",
      body: "Support escalates several payment failures. On-call looks at the green dashboard, sees no error spike, and closes the first report as a client problem.",
      tone: "danger",
    },
    {
      at: "T+01:05",
      title: "An external probe disagrees",
      body: "A synthetic check from outside the platform reports failing checkout requests. On-call compares the panel timestamp with the wall clock and finds that no samples have arrived for an hour.",
      tone: "info",
    },
    {
      at: "T+01:15",
      title: "The incident runs blind",
      body: "Responders switch to load-balancer 5xx counts, probe results, deploy markers, and audit events. They roll back the checkout release and the collector configuration in parallel.",
      tone: "warn",
    },
    {
      at: "T+01:40",
      title: "Telemetry returns in a burst",
      body: "Buffered and newly scraped samples arrive together, and delayed alerts fire for conditions that are already resolving. The team verifies recovery with the probe and edge metrics, not the backlog.",
      tone: "success",
    },
    {
      at: "T+02:30",
      title: "Incident closed",
      body: "Checkout is healthy and the pipeline is stable. The review focuses on why a monitoring change was able to remove the evidence needed to debug the incident it coincided with.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "first-check",
      prompt: "Users report failures while every dashboard is green. What do you check first?",
      options: [
        {
          id: "freshness",
          label: "Check data freshness: last scrape time, ingestion lag, and collector health.",
          consequence:
            "The missing samples are visible within a minute. On-call learns that the dashboard is stale, stops treating green as healthy, and starts using signals that still work.",
          quality: "good",
        },
        {
          id: "service-health",
          label: "Open the service's dependency dashboard and look for a slow downstream.",
          consequence:
            "That dashboard is fed by the same pipeline, so it is equally stale. The search stays inside the broken tool and produces confident conclusions from old data.",
          quality: "mixed",
        },
        {
          id: "trust-dashboard",
          label: "Treat the green dashboard as evidence and deprioritize the reports.",
          consequence:
            "Real user impact continues while responders wait for a signal that cannot arrive. Trust in the dashboard becomes the mechanism that extends the outage.",
          quality: "poor",
        },
      ],
      debrief:
        "Green is a value; fresh is a property. A dashboard that has not received data cannot be green in any meaningful sense, but many panels render the last known value and many alert rules treat no-data as OK. Checking freshness first separates a telemetry outage from a service outage and prevents the team from debugging with a dead instrument.",
    },
    {
      id: "blind-response",
      prompt: "Telemetry is degraded and the user-facing failure is real. How should the response proceed?",
      options: [
        {
          id: "independent-signals",
          label: "Use independent signals, state the blind spot in incident comms, and mitigate the user impact.",
          consequence:
            "Edge 5xx, probes, deploy markers, and audit events provide enough evidence to act. Comms make clear which conclusions are measured and which are inferred, so the team does not overclaim.",
          quality: "good",
        },
        {
          id: "restore-first",
          label: "Pause mitigation and restore the monitoring pipeline first.",
          consequence:
            "The team spends the most valuable minutes repairing an instrument while customers continue to fail. Monitoring recovery may also take longer than the application rollback that would have reduced impact.",
          quality: "mixed",
        },
        {
          id: "wait",
          label: "Wait for telemetry to return before making any change.",
          consequence:
            "The outage continues with no time bound. Waiting is only reasonable when the blind spot is small and impact is unconfirmed; here the probes already show failures.",
          quality: "poor",
        },
      ],
      debrief:
        "Incidents do not pause because observability is degraded. The response needs a second, independent evidence path: external probes, load-balancer metrics, deploy history, and audit logs usually live outside the failed pipeline. Parallel work is appropriate, but user impact comes first. Say explicitly what is unknown so decisions are not mistaken for measurements.",
    },
    {
      id: "lasting-control",
      prompt: "Which control would have caught this before users did?",
      options: [
        {
          id: "dead-man",
          label: "Add a dead-man's switch, no-data alerts, and an out-of-band probe owned by a different system.",
          consequence:
            "Absence of telemetry becomes a page instead of a silent OK, and the probe provides a second opinion during pipeline failures. The monitoring system is tested by something it does not control.",
          quality: "good",
        },
        {
          id: "more-dashboards",
          label: "Add more service dashboards with the same data source.",
          consequence:
            "Coverage looks better, but every new panel depends on the same collectors and storage. The next pipeline failure blinds all of them at once.",
          quality: "poor",
        },
        {
          id: "longer-retention",
          label: "Increase retention so historical data is available during an incident.",
          consequence:
            "History helps the postmortem but does not tell responders what is happening now. Retention also raises cost without adding a single live signal.",
          quality: "mixed",
        },
      ],
      debrief:
        "A monitoring system needs a heartbeat that is expected to arrive and an alarm when it does not. Pair that with at least one probe path outside the platform's own telemetry stack, and give collectors resource headroom plus a canary stage. The goal is not more panels; it is an explicit failure state for the observability system itself.",
    },
  ],
  postmortem: [
    { type: "h3", text: "What happened" },
    {
      type: "p",
      text: "A collector configuration change reduced the memory limit while increasing batch size. Collectors were killed and restarted, and the telemetry pipeline stopped delivering samples. Dashboards kept their last values and alerts treated missing data as healthy. A separate application deploy then failed, but responders saw green panels and initially discounted user reports.",
    },
    { type: "h3", text: "Why it stayed hidden" },
    {
      type: "list",
      items: [
        "No alert fired on missing or stale data; the absence of samples was interpreted as the absence of problems.",
        "The collector rollout had no canary and no resource check against the new batch size.",
        "The synthetic probe was the only independent signal, and it was not part of the primary dashboard.",
        "Incident communication had no way to mark conclusions as unverified while telemetry was down.",
      ],
    },
    { type: "h3", text: "What changed" },
    {
      type: "list",
      items: [
        "A dead-man's switch pages when expected telemetry stops arriving.",
        "Alert rules distinguish no-data from OK and require an explicit policy for each.",
        "Collector changes roll out to one zone first with memory and drop-rate gates.",
        "An external probe and edge error metrics are pinned on the first incident screen.",
      ],
    },
    { type: "h3", text: "What generalizes" },
    {
      type: "p",
      text: "Observability is part of the incident response path, so it needs its own availability target and its own independent check. The dangerous failure is not a dashboard that says bad; it is a dashboard that says nothing and looks calm. Every monitoring system should be able to answer whether it is currently able to observe.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times and observations in this file are illustrative. They describe a composite scenario, not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "Alerting",
      url: "https://prometheus.io/docs/practices/alerting/",
      publisher: "Prometheus",
      kind: "docs",
      note: "Alert quality, dead-man's switches, and missing-data behavior.",
    },
    {
      title: "Creating a CloudWatch alarm based on a static threshold",
      url: "https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/AlarmThatSendsEmail.html",
      publisher: "Amazon CloudWatch",
      kind: "docs",
      note: "Treating missing data and alarm states explicitly.",
    },
    {
      title: "OpenTelemetry Collector",
      url: "https://opentelemetry.io/docs/collector/",
      publisher: "OpenTelemetry",
      kind: "docs",
      note: "Collector deployment, batching, memory limits, and pipeline health.",
    },
    {
      title: "Grafana Alerting",
      url: "https://grafana.com/docs/grafana/latest/alerting/",
      publisher: "Grafana Labs",
      kind: "docs",
      note: "Alert rule evaluation, no-data states, and notification routing.",
    },
  ],
};
