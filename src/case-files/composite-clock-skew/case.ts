import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Clock skew corrupted the incident timeline and misattributed cause",
  accuracyNote:
    "This is an original composite scenario, not a real incident. It combines common time-synchronization, logging, and timeline-reconstruction failure modes into one representative case. It does not describe any company's architecture, dates, traffic, or internal decisions. All times and telemetry are illustrative.",
  timeline: [
    {
      at: "T-4 days",
      title: "Time synchronization is blocked",
      body: "A network policy removes outbound time-sync traffic from the application subnet. Hosts keep using their local clocks, and no alert watches the offset between each host and a trusted time source.",
      tone: "warn",
    },
    {
      at: "T+00:00",
      title: "A pool setting is reduced",
      body: "A routine configuration rollover lowers the connection pool limit for a checkout service. The old value was sized for peak concurrency, so requests begin to wait for a connection.",
      tone: "warn",
    },
    {
      at: "T+00:02",
      title: "Errors begin",
      body: "Checkout errors rise as pool waits exceed the request deadline. The application hosts' clocks are about nine minutes ahead, so their logs record these failures several minutes later than the metrics pipeline does.",
      tone: "danger",
    },
    {
      at: "T+00:10",
      title: "An unrelated deploy completes",
      body: "A frontend release finishes and is recorded by the build system with an accurate clock. In a raw timestamp sort, the deploy appears just before the application logs report failures.",
      tone: "info",
    },
    {
      at: "T+00:18",
      title: "The deploy becomes the suspect",
      body: "The incident channel compares the deploy time with the first application error and sees a plausible sequence. The frontend release is now the leading theory even though it changed only static assets.",
      tone: "danger",
    },
    {
      at: "T+00:26",
      title: "Traces disagree with the logs",
      body: "Trace spans show pool waits beginning before the deploy artifact was published. Request identifiers connect failing requests to the pool setting, and the metrics pipeline's receive times agree with the traces rather than the application logs.",
      tone: "warn",
    },
    {
      at: "T+00:40",
      title: "The pool setting is restored",
      body: "The team reverts the pool limit, and checkout recovers without touching the frontend release. The timeline is rebuilt with measured offsets and source confidence.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "order-events",
      prompt:
        "The deploy timestamp precedes the first application error. Do you roll back the deploy?",
      options: [
        {
          id: "trace-first",
          label:
            "Use trace parent-child order, request identifiers, and metric receive times before changing anything.",
          consequence:
            "The team establishes that pool waits began before the release existed. The real trigger is found without an unrelated rollback, and the timeline gains a source that does not depend on host clocks.",
          quality: "good",
        },
        {
          id: "rollback-deploy",
          label: "Roll back the deploy because the timestamps make it the most likely cause.",
          consequence:
            "The release is removed and service eventually recovers, but the pool setting remains wrong. The rollback also changes the system while evidence is still being collected, so the next occurrence starts from a more confusing baseline.",
          quality: "mixed",
        },
        {
          id: "trust-logs",
          label: "Trust the application logs because they contain the most detailed error messages.",
          consequence:
            "Detailed messages are mistaken for reliable ordering. The team follows a false sequence, blames the deploy, and misses the configuration change that actually reduced capacity.",
          quality: "poor",
        },
      ],
      debrief:
        "Log detail and timestamp accuracy are different properties. Traces encode causality through parent-child relationships, and request identifiers connect observations across systems even when their clocks disagree. When sources conflict, prefer relationships and receive times over the local clock of the host that produced a message.",
    },
    {
      id: "rebuild-timeline",
      prompt: "How should the postmortem timeline be rebuilt?",
      options: [
        {
          id: "measured-offsets",
          label:
            "Measure each host's offset, normalize with source confidence, and keep causal markers alongside timestamps.",
          consequence:
            "The timeline shows both event time and uncertainty, so a nine-minute skew cannot silently reorder events. Readers can see which conclusions depend on a corrected clock and which depend on causality.",
          quality: "good",
        },
        {
          id: "average-shift",
          label: "Shift every application log by the average measured offset.",
          consequence:
            "The overall sequence improves, but hosts with different offsets are moved by the same amount. A small residual skew can still reverse two close events and preserve the wrong conclusion.",
          quality: "mixed",
        },
        {
          id: "one-source",
          label: "Use only the metrics pipeline because infrastructure timestamps are more trustworthy.",
          consequence:
            "Ordering becomes consistent, but the timeline loses application context and deploy events. Consistency is not completeness, and a single source can still be wrong in the same direction.",
          quality: "poor",
        },
      ],
      debrief:
        "A good timeline carries provenance: which source produced each event, how its clock was synchronized, and how much confidence to place in its ordering. Normalize per source, not by a global average, and keep causal evidence such as trace links and request identifiers beside the timestamps.",
    },
    {
      id: "prevent-skew",
      prompt: "What control makes the next incident timeline trustworthy?",
      options: [
        {
          id: "monitor-offset",
          label:
            "Alert on clock offset, enforce time synchronization, and record both event time and ingest time in UTC.",
          consequence:
            "Skew becomes a visible infrastructure fault instead of a postmortem surprise. Ingest time gives every event a second ordering signal that does not depend on the source host.",
          quality: "good",
        },
        {
          id: "manual-check",
          label: "Check time synchronization manually during each incident.",
          consequence:
            "The check may catch a large offset, but it is easy to skip under pressure and does not reveal drift that accumulated days earlier. It also depends on someone remembering the possibility.",
          quality: "mixed",
        },
        {
          id: "drop-timestamps",
          label: "Remove timestamps from application logs and rely on log arrival order.",
          consequence:
            "Host clocks no longer mislead, but arrival order through buffers and collectors is not event order. Latency and batching can reorder messages silently, and the timeline loses useful precision.",
          quality: "poor",
        },
      ],
      debrief:
        "Time synchronization is a production dependency, not a host detail. An offset metric with an alert catches drift before an incident, while ingest timestamps preserve a second ordering signal when source clocks fail. UTC everywhere removes timezone ambiguity but not skew; the two controls solve different problems.",
    },
  ],
  postmortem: [
    {
      type: "h3",
      text: "What happened",
    },
    {
      type: "p",
      text: "A network policy blocked time synchronization on the application hosts, and their clocks ran about nine minutes ahead. A pool configuration change caused checkout failures, but the skewed application logs placed those failures after an unrelated frontend deploy. Traces and request identifiers showed the true order, and the pool setting was restored.",
    },
    {
      type: "h3",
      text: "What made it worse",
    },
    {
      type: "list",
      items: [
        "No alert watched clock offset, so skew accumulated for days without a signal.",
        "The first timeline sorted raw timestamps from sources with different clock quality.",
        "The deploy system and application hosts logged in different time domains without recording ingest time.",
        "The most detailed source was treated as the most authoritative source.",
      ],
    },
    {
      type: "h3",
      text: "What changed",
    },
    {
      type: "list",
      items: [
        "Hosts alert when their offset from a trusted time source exceeds a small threshold.",
        "Time synchronization is required for workloads, and blocked time traffic is treated as a configuration defect.",
        "Logs and events record UTC event time plus collector ingest time.",
        "The incident template requires source, clock quality, and confidence for each timeline entry.",
      ],
    },
    {
      type: "h3",
      text: "What generalizes",
    },
    {
      type: "p",
      text: "Timestamps are observations, not facts. A timeline built by sorting them inherits every clock error in the system. Causality comes from relationships: a trace parent that started before its child, a request that reached the edge before a pool wait, a deploy artifact that did not exist when the first failure occurred. Measure skew, keep provenance, and let causal evidence outrank a plausible-looking clock.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, offsets, and sequence observations in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "ntpd — Network Time Protocol daemon",
      url: "https://www.ntp.org/documentation/4.2.8-series/ntpd/",
      publisher: "NTP Project",
      kind: "docs",
      note: "Clock synchronization, drift, and offset behavior.",
    },
    {
      title: "systemd-timesyncd.service",
      url: "https://www.freedesktop.org/software/systemd/man/latest/systemd-timesyncd.service.html",
      publisher: "systemd Documentation",
      kind: "docs",
      note: "Time synchronization service behavior and status.",
    },
    {
      title: "Set the time for your Linux instance",
      url: "https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/set-time.html",
      publisher: "Amazon Web Services",
      kind: "docs",
      note: "Instance time sources and the effect of blocked time traffic.",
    },
  ],
};
