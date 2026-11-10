import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "CPU starvation after adding a service-mesh sidecar",
  accuracyNote:
    "This is an original composite scenario and not a real incident. It combines common sidecar resource-sizing, CPU-throttling, and autoscaling failure modes into one representative case. It does not describe any company's architecture, traffic, dates, or internal decisions. All times and telemetry are illustrative.",
  timeline: [
    {
      at: "T+00:00",
      title: "The mesh is enabled",
      body: "A namespace is enrolled in the service mesh. Each replica restarts with an application container and a proxy sidecar. The application's CPU request and limit are unchanged; the sidecar receives a limit but no request.",
      tone: "info",
    },
    {
      at: "T+00:20",
      title: "Latency rises after the restart",
      body: "p99 for the service rises from 140 ms to 520 ms. The application's own CPU usage is only 60% of its limit, so the first dashboard view looks healthy.",
      tone: "warn",
    },
    {
      at: "T+00:45",
      title: "The node is packed",
      body: "The scheduler placed the pods using only the application requests because the sidecar request was zero. Node CPU reaches 96%, and both containers compete for the same remaining capacity.",
      tone: "warn",
    },
    {
      at: "T+01:10",
      title: "Per-container throttling appears",
      body: "The application container is throttled in 32% of CFS periods; the sidecar is throttled in 18%. Application usage below its limit was misleading: the cgroup was being held back while runnable.",
      tone: "danger",
    },
    {
      at: "T+01:40",
      title: "Scaling out does not help",
      body: "The team adds replicas manually because the autoscaler, watching application CPU, stays below its target. New pods land on the same busy nodes, add more sidecars, and increase total proxy work without adding schedulable headroom.",
      tone: "danger",
    },
    {
      at: "T+02:20",
      title: "The budget is corrected",
      body: "The team sets explicit requests equal to limits for both containers, raises the application request to cover measured usage plus proxy overhead, and adds node headroom. A rolling restart restores p99 to 170 ms.",
      tone: "success",
    },
    {
      at: "T+1 day",
      title: "The sidecar is trimmed",
      body: "Access-log sampling and metric-cardinality limits cut proxy CPU by roughly a third, recovering most of the added capacity cost while keeping mTLS and routing.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "first-diagnosis",
      prompt:
        "The app container reports 60% CPU usage but latency has tripled since the mesh restart. What should you inspect first?",
      options: [
        {
          id: "per-container-throttling",
          label:
            "Compare per-container CPU usage, limits, and throttled periods alongside node allocatable capacity.",
          consequence:
            "The data shows the app being throttled despite low average usage, and the sidecar consuming unrequested capacity. The team can correct the budget instead of guessing at application code.",
          quality: "good",
        },
        {
          id: "scale-out",
          label: "Add replicas immediately to spread the load.",
          consequence:
            "New replicas add more sidecars and may be scheduled onto the same saturated nodes. The autoscaler signal stays below target, so the change adds work without restoring headroom.",
          quality: "mixed",
        },
        {
          id: "rollback-mesh",
          label: "Remove the mesh from the namespace as the first action.",
          consequence:
            "Latency may recover, but the team loses the traffic policy and identity features and still does not know how much CPU the proxy needs. The next enrollment repeats the failure.",
          quality: "mixed",
        },
      ],
      debrief:
        "Average usage below a limit does not prove the container has CPU when it needs it. CFS throttling happens when a cgroup exhausts its quota inside a period, even if its average over a minute looks modest. Per-container throttling, usage, and limits separate the application from the proxy. Node allocatable capacity then explains why both are competing: a zero sidecar request understates the pod's real footprint.",
    },
    {
      id: "lasting-sizing",
      prompt: "What should the durable resource model for a meshed workload contain?",
      options: [
        {
          id: "explicit-budget",
          label:
            "Set explicit requests and limits for every container, include proxy overhead in capacity and autoscaling, and alert on throttling.",
          consequence:
            "Scheduling reflects the real pod footprint, the proxy has guaranteed capacity, and the application keeps headroom under burst. Autoscaling and capacity plans stop underestimating each replica.",
          quality: "good",
        },
        {
          id: "raise-app-limit",
          label: "Raise only the application container's CPU limit.",
          consequence:
            "The application can burst higher, but the pod still requests too little and the sidecar still competes without a reservation. Nodes remain overpacked and the proxy can become the throttled component.",
          quality: "mixed",
        },
        {
          id: "remove-limits",
          label: "Remove CPU limits from both containers and rely on requests.",
          consequence:
            "Bursting becomes easier, but a noisy proxy or application can consume node capacity and starve neighbors. Without limits, the failure moves from a local throttle to node-wide contention.",
          quality: "poor",
        },
      ],
      debrief:
        "A sidecar is part of the workload's CPU budget whether or not it appears in the application's dashboard. Requests determine placement and must include proxy overhead; limits determine the maximum burn and should be set deliberately for both containers. Autoscaling that watches only application CPU can miss proxy-driven load entirely. The useful control loop is per-container throttling, not a pod-average utilization number.",
    },
  ],
  postmortem: [
    { type: "h3", text: "What happened" },
    {
      type: "p",
      text: "Enrolling the service in the mesh added a proxy container to every replica. The proxy had a CPU limit but no request, so the scheduler packed pods as if the proxy did not exist. Under normal traffic, the application and proxy together exceeded the node's available CPU, and both containers were throttled. Latency rose even though the application's average utilization stayed below its own limit.",
    },
    { type: "h3", text: "What made it worse" },
    {
      type: "list",
      items: [
        "The sidecar request was zero, so pod density was planned without proxy overhead.",
        "Dashboards showed application CPU but not CFS throttled periods per container.",
        "The autoscaler used application CPU only and ignored proxy work and node pressure.",
        "Adding replicas increased the number of sidecars on already saturated nodes.",
        "The proxy was doing full access logging and high-cardinality metrics, raising its own cost.",
      ],
    },
    { type: "h3", text: "What changed" },
    {
      type: "list",
      items: [
        "Every container declares requests and limits; the sidecar request reflects measured peak proxy CPU.",
        "Capacity planning and autoscaling use total pod requests plus a headroom target, not application CPU alone.",
        "Alerts fire on sustained per-container throttling and on node CPU pressure, not only on latency.",
        "Proxy telemetry is sampled, log volume is capped, and metric labels are reviewed before release.",
      ],
    },
    { type: "h3", text: "What generalizes" },
    {
      type: "p",
      text: "A sidecar is not free metadata; it is a second process with its own CPU, memory, and connection state. The failure is usually a budgeting error, not a malicious proxy. Measure the whole pod, give each container a reservation, and keep enough node headroom for both to burst. If the proxy's work grows with request rate, connection churn, or payload size, those dimensions belong in the capacity model too.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, percentages, and latency values in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "Resource Management for Pods and Containers",
      url: "https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/",
      publisher: "Kubernetes",
      kind: "docs",
      note: "Requests, limits, and CPU throttling behavior.",
    },
    {
      title: "Sidecar Containers",
      url: "https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/",
      publisher: "Kubernetes",
      kind: "docs",
      note: "Sidecar lifecycle and resource sharing within a pod.",
    },
    {
      title: "Performance and Scalability",
      url: "https://istio.io/latest/docs/ops/deployment/performance-and-scalability/",
      publisher: "Istio",
      kind: "docs",
      note: "Proxy overhead and sizing guidance for mesh sidecars.",
    },
    {
      title: "Amazon ECS Task Definition Parameters",
      url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html",
      publisher: "Amazon Web Services",
      kind: "docs",
      note: "Task-level and container-level CPU allocation.",
    },
  ],
};
