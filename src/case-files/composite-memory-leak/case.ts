import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Slow heap growth masked by periodic task restarts",
  accuracyNote:
    "This is an original composite scenario, not a real incident and not a real company incident. It combines common memory-growth, restart, and heap-instrumentation failure modes into one representative scenario. It does not describe any company's architecture, traffic, dates, or internal decisions. All times are relative and all telemetry is illustrative.",
  timeline: [
    {
      at: "Day 0",
      title: "A new request cache is deployed",
      body: "To reduce repeated lookups, the service adds an in-memory map keyed by a request identifier. Entries are written on every unique request, and no eviction policy is configured.",
      tone: "info",
    },
    {
      at: "Day 1",
      title: "Memory rises slowly",
      body: "Resident memory grows by roughly 60 to 80 MiB per day. Traffic is steady, so the increase does not look like demand. No alert watches the slope, only the current percentage of the limit.",
      tone: "warn",
    },
    {
      at: "Day 2",
      title: "The first OOM kill restarts the task",
      body: "Memory reaches the 2 GiB limit and the container is killed. The replacement starts near a low baseline, so the graph appears to recover. The event is treated as a sporadic platform restart.",
      tone: "warn",
    },
    {
      at: "Day 6",
      title: "Restarts become regular",
      body: "The task is now recycled roughly every 48 hours. Each restart resets the memory graph, and no single view spans multiple task lifetimes. Latency blips during warm-up are attributed to deploys.",
      tone: "danger",
    },
    {
      at: "Day 9",
      title: "Heap evidence is captured",
      body: "The team takes heap snapshots after forced garbage collection on one instance and compares them over several hours. Retained objects grow with unique request count, and the new cache dominates the retained set.",
      tone: "info",
    },
    {
      at: "Day 10",
      title: "The unbounded cache is confirmed",
      body: "Request identifiers are unique, so every request adds an entry that is never read again. The cache has a high hit rate only because the process restarts before memory limits are reached.",
      tone: "danger",
    },
    {
      at: "Day 11",
      title: "A bounded cache is deployed",
      body: "The map is replaced with a size- and time-bounded cache. Memory still rises within a normal band, but post-GC heap stops trending upward across days.",
      tone: "success",
    },
    {
      at: "Day 20",
      title: "A full restart cycle passes without growth",
      body: "The service runs past its previous 48-hour failure interval with stable post-GC heap. The team adds a cross-restart memory trend and a heap budget to the dashboard.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "what-to-measure",
      prompt: "The task restarts every two days and memory looks fine after each restart. What do you measure?",
      options: [
        {
          id: "post-gc-across-restarts",
          label: "Post-GC heap over several days, joined across task lifetimes and normalized by request volume.",
          consequence:
            "The reset graph becomes one continuous trend. Growth per request separates a leak from a stable working set and shows whether traffic explains the slope.",
          quality: "good",
        },
        {
          id: "current-utilization",
          label: "Current memory utilization against the container limit.",
          consequence:
            "The percentage looks healthy immediately after each restart and only spikes before a kill. The periodic pattern hides the underlying slope and delays diagnosis.",
          quality: "poor",
        },
        {
          id: "restart-frequency",
          label: "Count restarts and tune the restart schedule.",
          consequence:
            "More frequent restarts may reduce user-visible OOMs, but they destroy evidence and leave the leak in place. The service becomes dependent on recycling.",
          quality: "mixed",
        },
      ],
      debrief:
        "Memory that resets at every restart needs a view that survives restarts. Plot post-GC heap, not raw RSS, and join lifetimes on one axis. Normalizing by requests distinguishes a per-request leak from a larger working set or a traffic increase. Without that baseline, a sawtooth looks like repeated healthy recoveries.",
    },
    {
      id: "immediate-mitigation",
      prompt: "The service is still leaking and a restart is due. What is the best immediate action?",
      options: [
        {
          id: "capture-and-drain",
          label: "Capture a heap profile, then drain and recycle the instance under controlled conditions.",
          consequence:
            "Evidence is preserved before the process disappears, and the restart happens on the team's terms rather than at the memory limit. Other instances keep serving traffic.",
          quality: "good",
        },
        {
          id: "raise-limit",
          label: "Raise the memory limit so the task stops being killed.",
          consequence:
            "The interval between failures lengthens, but the leak continues and the eventual kill is larger. More memory per task also reduces safe deployment density.",
          quality: "mixed",
        },
        {
          id: "restart-all",
          label: "Restart every task at once to reset memory.",
          consequence:
            "Memory returns to baseline, but all in-flight requests are lost and the fleet warms up together. The leak remains, and the synchronized restart adds avoidable risk.",
          quality: "poor",
        },
      ],
      debrief:
        "A restart is a temporary control, not a diagnosis. Capture state first, then recycle one instance at a time so capacity and evidence survive. Raising the limit can buy time, but it changes the failure interval rather than the trend. Any restart should be deliberate, staggered, and recorded so it does not masquerade as recovery.",
    },
    {
      id: "durable-control",
      prompt: "What set of controls would catch the next slow leak before it causes OOM kills?",
      options: [
        {
          id: "bounded-and-alerted",
          label: "Bound in-memory structures and alert on post-GC heap growth per request across restarts.",
          consequence:
            "The leak class is constrained at the source, and the remaining trend is visible while there is still time to act. Restarts stop being part of normal operation.",
          quality: "good",
        },
        {
          id: "oom-alert",
          label: "Alert only when the container approaches its memory limit.",
          consequence:
            "The alert fires near the failure point, after the process has already been unstable. It detects the symptom but leaves little time to capture evidence or drain traffic.",
          quality: "mixed",
        },
        {
          id: "scheduled-restarts",
          label: "Restart the service on a fixed schedule before it can reach the limit.",
          consequence:
            "Users see fewer OOM kills, but the leak is normalized and evidence is erased on a schedule. Capacity planning becomes tied to the restart interval.",
          quality: "poor",
        },
      ],
      debrief:
        "Prevention has two layers: bounded data structures and a leading indicator. A size or time bound stops unbounded retention; a post-GC growth alert catches leaks that still slip through. Alerting only at the limit is a lagging signal. Scheduled restarts can be a stopgap, but they turn a defect into an operating procedure.",
    },
  ],
  postmortem: [
    {
      type: "h3",
      text: "What happened",
    },
    {
      type: "p",
      text: "A new in-memory cache retained one entry per unique request with no eviction. Heap grew slowly, and the container was killed when it reached its limit. Each restart reset the memory graph, so the service appeared to recover every two days while the underlying trend continued.",
    },
    {
      type: "h3",
      text: "Why it stayed hidden",
    },
    {
      type: "list",
      items: [
        "Memory dashboards reset at each restart and never joined task lifetimes.",
        "The only alert watched utilization near the limit, not the slope after garbage collection.",
        "Restarts were attributed to platform instability rather than application growth.",
        "No heap profile was captured before the process was killed.",
      ],
    },
    {
      type: "h3",
      text: "What changed",
    },
    {
      type: "list",
      items: [
        "Caches have explicit size and time bounds, and unbounded maps are rejected in review.",
        "Post-GC heap is graphed across restarts and normalized by request volume.",
        "A heap-growth alert fires well before the container limit.",
        "Runbooks require a profile capture and staggered drain before recycling a leaking task.",
      ],
    },
    {
      type: "h3",
      text: "What generalizes",
    },
    {
      type: "p",
      text: "Restarts hide leaks by resetting the only graph that shows them. Measure retained memory after collection, join the data across process lifetimes, and divide by work performed. A stable working set plateaus; a leak keeps its slope. Bound every in-memory structure that grows with unique input, and treat repeated OOM kills as a signal to investigate, not a capacity setting.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, memory values, and restart intervals in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "Using heap snapshots",
      url: "https://nodejs.org/en/learn/diagnostics/memory/using-heap-snapshot",
      publisher: "Node.js",
      kind: "docs",
      note: "Retained objects, heap snapshots, and comparison over time.",
    },
    {
      title: "Assign memory resources to containers and pods",
      url: "https://kubernetes.io/docs/tasks/configure-pod-container/assign-memory-resource/",
      publisher: "Kubernetes",
      kind: "docs",
      note: "Memory limits, requests, and OOM termination behavior.",
    },
    {
      title: "Troubleshoot memory leaks",
      url: "https://docs.oracle.com/en/java/javase/21/troubleshoot/troubleshoot-memory-leaks.html",
      publisher: "Oracle",
      kind: "docs",
      note: "Heap growth analysis and leak evidence collection.",
    },
  ],
};
