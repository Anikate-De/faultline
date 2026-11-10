import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "public",
  company: "Google Cloud",
  date: "June 2, 2019",
  incidentClass: "Network control-plane failure across multiple US regions",
  accuracyNote:
    "Verified against Google Cloud's incident report for networking incident 19009 and Google's follow-up blog post. The report is internally inconsistent about the end time: its header lists 15:40 Pacific, while its narrative says full service resumed at 16:10 and per-region durations range from 3 hours 19 minutes to 4 hours 25 minutes. This case uses the narrative clock for the final recovery and notes the discrepancy rather than hiding it. The June 4 blog gives a higher-level cause — a configuration change applied to more servers than intended — that does not match the report's account of maintenance automation descheduling the control plane; this case follows the detailed report. The report describes instances as inaccessible, not failed, so the case treats reachability as distinct from process health. It does not publish the maintenance job's name or the affected customers. No telemetry is reconstructed.",
  timeline: [
    {
      at: "T+00:00",
      title: "Maintenance automation runs",
      body: "At 11:45 a.m. Pacific, a maintenance event begins in one physical location. The automation builds a list of logical clusters to deschedule. The list includes the network control plane, and it also includes network control jobs in other physical locations.",
      tone: "warn",
    },
    {
      at: "T+00:02",
      title: "BGP routes are withdrawn",
      body: "The network is designed to fail static and runs for several minutes without its control plane. After that window, BGP routing between affected locations is withdrawn. Network capacity falls sharply and some regions become unreachable. End-user impact begins at 11:47–11:49.",
      tone: "danger",
    },
    {
      at: "T+00:02",
      title: "Incident response starts",
      body: "Google engineers are alerted two minutes after the failure begins and start major-incident protocols. Debugging is slowed because response tools compete for the congested network; teams fall back to backup plans and reduce priority for less critical traffic.",
      tone: "danger",
    },
    {
      at: "T+01:16",
      title: "The automation is halted",
      body: "At 13:01, the incident is root-caused and engineers stop the automation software responsible for the maintenance event. Re-enabling the control plane is not instantaneous: configuration data was lost and must be rebuilt and redistributed across several locations.",
      tone: "warn",
    },
    {
      at: "T+02:18",
      title: "New configuration rolls out",
      body: "At 14:03, the rebuilt network configuration begins to roll out. In parallel, product teams direct traffic away from affected regions so services can continue serving from elsewhere where possible.",
      tone: "info",
    },
    {
      at: "T+03:34",
      title: "Capacity starts returning",
      body: "Network capacity begins to recover at 15:19 as the control plane is rescheduled and configuration reaches each location. Recovery varies by region and by which Google services depend on the affected paths.",
      tone: "info",
    },
    {
      at: "T+04:25",
      title: "Full service resumes",
      body: "Google reports full service at 16:10 Pacific. Some products have a longer tail: about 50% of Cloud Endpoints configuration push workflows fail until June 4, and new endpoint configurations can take up to an hour to propagate afterward.",
      tone: "success",
    },
    {
      at: "Days later",
      title: "The tail outlives the network",
      body: "Regional compute, storage, and Spanner availability recover with the network, but configuration-dependent products remain degraded. The incident shows that recovery is per-service, not a single switch back to normal.",
      tone: "warn",
    },
  ],
  decisions: [
    {
      id: "halt-automation",
      prompt:
        "A maintenance process is descheduling infrastructure in several locations at once. What is the first control?",
      options: [
        {
          id: "halt-and-scope",
          label:
            "Halt the automation immediately, then establish which jobs and locations were descheduled.",
          consequence:
            "Stopping the process prevents further descheduling while the team learns the blast radius. Recovery can then be planned for the exact set of affected clusters.",
          quality: "good",
        },
        {
          id: "let-finish",
          label: "Let the maintenance event finish so the system reaches a known state.",
          consequence:
            "The automation has already crossed location boundaries. Letting it continue removes more control-plane capacity and makes recovery depend on an even larger rebuild.",
          quality: "poor",
        },
        {
          id: "page-only",
          label: "Page the network team and wait for its assessment before touching the automation.",
          consequence:
            "The network team is necessary, but the automation keeps acting while the assessment happens. Delay increases the number of clusters that must be restored.",
          quality: "mixed",
        },
      ],
      debrief:
        "The bug was not that maintenance ran. It was that the automation accepted a job list spanning independent clusters in different physical locations and descheduled them together. Halting it is reversible and narrows the incident. The harder work is rebuilding the configuration that the control plane lost, which is why stopping further damage comes first.",
    },
    {
      id: "localize-the-fault",
      prompt:
        "Instances in several regions are unreachable, but nothing indicates a compute failure. How do you localize the fault?",
      options: [
        {
          id: "network-path",
          label:
            "Treat it as a network-path fault: check provider status, route and BGP state, and packet loss before changing instances.",
          consequence:
            "The evidence points to withdrawn routes rather than failed compute. The team avoids instance churn and focuses on restoring the control plane and steering traffic to unaffected regions.",
          quality: "good",
        },
        {
          id: "replace-instances",
          label: "Replace the unreachable instances and rebuild the affected regional capacity.",
          consequence:
            "Replacement instances inherit the same unreachable network path. The work adds load and cost without restoring connectivity, and it can destroy the evidence that would localize the fault.",
          quality: "poor",
        },
        {
          id: "failover-blind",
          label: "Fail every application over to another region as soon as the first errors appear.",
          consequence:
            "Cross-region failover may help some services, but without checking capacity, dependencies, and which regions are affected, it can overload the target or move the outage.",
          quality: "mixed",
        },
      ],
      debrief:
        "The break condition in this case is precisely the wrong reflex: replacing instances while the network is the cause. Reachability has to be tested separately from process health. Provider status gives the regional shape, route state shows whether prefixes are withdrawn, and packet loss distinguishes congestion from application failure. Only then does failover make sense.",
    },
    {
      id: "control-plane-durability",
      prompt:
        "The control plane was restored, but its configuration had to be rebuilt across locations. Which change most reduces the next recovery time?",
      options: [
        {
          id: "persist-and-harden",
          label:
            "Persist control-plane configuration locally, extend fail-static, and make the automation reject cross-location actions.",
          consequence:
            "Recovery no longer depends on reconstructing configuration during congestion. The network survives longer without its control plane, and the specific class of multi-location descheduling is blocked.",
          quality: "good",
        },
        {
          id: "more-replicas",
          label: "Add more control-plane replicas in the same automation domain.",
          consequence:
            "Additional replicas improve normal redundancy but do not help when the automation deschedules independent clusters together. More replicas can mean more jobs removed by the same bug.",
          quality: "mixed",
        },
        {
          id: "manual-runbook",
          label: "Write a faster manual runbook for rebuilding configuration.",
          consequence:
            "A runbook helps, but it still requires people to reconstruct state while the network is degraded and tools are competing for bandwidth. It shortens the manual path without removing the need for it.",
          quality: "mixed",
        },
      ],
      debrief:
        "Google's remediation plan combined several layers: halt the automation, harden the cluster manager to reject requests that span locations, reconfigure the network control plane to handle maintenance correctly, persist configuration so it need not be rebuilt, and extend fail-static. No single control covers the whole failure. The durable lesson is that automation which can act across failure domains needs a hard boundary, not only a review process.",
    },
  ],
  postmortem: [
    { type: "h3", text: "What happened" },
    {
      type: "p",
      text: "Two normally benign misconfigurations and a software bug combined. Network control-plane jobs were configured to stop during a maintenance event, and multiple instances of the cluster management software running that control plane were eligible for a rare maintenance type. The maintenance software then descheduled multiple independent clusters at once, including clusters in different physical locations.",
    },
    { type: "h3", text: "Why the impact spread" },
    {
      type: "list",
      items: [
        "The maintenance job list crossed physical locations, so one event removed control-plane capacity in several places.",
        "The network's fail-static behavior lasted only minutes, after which BGP routes were withdrawn.",
        "Configuration data was lost with the control plane and had to be rebuilt and redistributed during the outage.",
        "Response tools competed for the same congested network, slowing diagnosis and communication.",
        "Impact varied by region and product; some services recovered later than the network itself.",
      ],
    },
    { type: "h3", text: "What changed" },
    {
      type: "list",
      items: [
        "The datacenter automation that deschedules jobs during maintenance was halted pending safeguards.",
        "Google committed to hardening the cluster management software to reject multi-location descheduling requests.",
        "Google committed to reconfiguring the network control plane to handle maintenance events and persist its configuration locally.",
        "Google committed to extending fail-static duration to provide a larger recovery window.",
        "Emergency response tooling and disaster recovery testing were to be reviewed and expanded to cover this failure class.",
      ],
    },
    { type: "h3", text: "What generalizes" },
    {
      type: "p",
      text: "A cloud region is not a single failure domain, and its control plane is not a background detail. Maintenance automation is production code with production blast radius. When the same tool can act on independent clusters, a local maintenance event becomes a multi-region outage. The control that matters is a hard rejection of cross-domain actions, not an assumption that operators will notice.",
    },
    {
      type: "p",
      text: "Fail-static is a budget. The network kept running for several minutes without its control plane, which bought time but not enough to rebuild configuration across locations. Systems that rely on a degraded mode should measure how long recovery actually takes and either extend the budget or remove the need to reconstruct state.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "One incident, several end times",
      body: "The network report lists a 15:40 end time in its header, describes full service at 16:10 in its narrative, and reports per-region durations from 3h19m to 4h25m. Cloud Endpoints configuration pushes remained degraded until June 4. Treating an incident as one global end timestamp hides the tail that customers actually experience.",
    },
  ],
  sources: [
    {
      title: "Google Cloud Networking Incident #19009",
      url: "https://status.cloud.google.com/incident/cloud-networking/19009",
      publisher: "Google Cloud",
      kind: "postmortem",
      note: "Primary source for the root cause, timeline, regional impact, and follow-up actions.",
    },
    {
      title: "An update on Sunday's service disruption",
      url: "https://cloud.google.com/blog/topics/inside-google-cloud/an-update-on-sundays-service-disruption",
      publisher: "Google Cloud Blog",
      kind: "docs",
      note: "Google's initial public update. It predates the detailed incident report and summarizes the cause differently; used for context only.",
    },
  ],
};
