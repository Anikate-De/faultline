import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "public",
  company: "Netflix",
  date: "December 24, 2012",
  incidentClass: "Regional load-balancer control-plane failure",
  accuracyNote:
    "Verified against Netflix's engineering postmortem and AWS's official event summary. Both describe the same incident. Netflix says the partial outage began around 12:30 p.m. Pacific, while AWS records the first ELB traffic stop at 12:24 p.m.; the timeline uses the AWS clock. The two sources also differ slightly on cleanup completion, so the case reports both rather than choosing one. The 6.8% impact figure and all recovery times come from AWS. No telemetry, device counts, or internal Netflix metrics are invented.",
  timeline: [
    {
      at: "T+00:00",
      title: "Traffic stops on a few load balancers",
      body: "At 12:24 p.m. PST, a maintenance process inadvertently run against production deletes part of the ELB control plane's state data. Traffic stops on a handful of load balancers used by a limited set of streaming devices. Other AWS services are unaffected.",
      tone: "warn",
    },
    {
      at: "T+03:06",
      title: "The failure spreads",
      body: "At about 3:30 p.m., additional ELBs serving game consoles, mobile devices, and other devices stop passing traffic. Netflix describes the impact as a partial outage that grows in scope through the afternoon, not an immediate blackout.",
      tone: "danger",
    },
    {
      at: "T+04:38",
      title: "AWS stops the bleeding",
      body: "At 5:02 p.m., AWS disables several ELB control-plane workflows, including scaling and descaling, so that no more running load balancers can be misconfigured by the missing state. At peak, 6.8% of running ELBs are affected.",
      tone: "warn",
    },
    {
      at: "T+14:21",
      title: "A snapshot is restored",
      body: "The first recovery method consumes several hours and produces no usable snapshot. At 2:45 a.m. on December 25, AWS successfully restores the ELB state data to a point just before the deletion.",
      tone: "info",
    },
    {
      at: "T+17:16",
      title: "State is verified",
      body: "By 5:40 a.m., AWS has merged the restored snapshot with changes made since and verified the result. Workflows and APIs are re-enabled slowly to avoid disturbing load balancers that were still working.",
      tone: "info",
    },
    {
      at: "T+10:06",
      title: "Consoles are patched back",
      body: "At about 10:30 p.m. on Christmas Eve, AWS patches the ELBs serving game consoles and similar devices back into service. Those devices had been affected for about seven hours.",
      tone: "info",
    },
    {
      at: "T+22:06",
      title: "Most load balancers recover",
      body: "By 10:30 a.m. on December 25, almost all affected load balancers are restored. AWS reports broad normal operation at 12:05 p.m.; Netflix separately reports some additional cleanup until about 8 a.m., when all its ELBs were restored.",
      tone: "success",
    },
    {
      at: "T+23:41",
      title: "Normal operation is confirmed",
      body: "AWS communicates that the service is operating normally at 12:05 p.m. Netflix's applications had been healthy throughout; the failure was in the path that delivered requests to them.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "zonal-assumption",
      prompt:
        "You run across three availability zones and can lose one without losing functionality. Is that sufficient isolation?",
      options: [
        {
          id: "map-regional-deps",
          label:
            "Map regional control-plane dependencies and build an ingress path that can leave the region.",
          consequence:
            "The design distinguishes workload placement from the regional services that route traffic to it. It exposes that ELB configuration is regional even when the instances behind it are zonal.",
          quality: "good",
        },
        {
          id: "add-a-zone",
          label: "Add a fourth availability zone and keep the same load-balancing model.",
          consequence:
            "More zones improve tolerance of a zonal failure but do nothing for a control-plane failure that spans every zone in the region. The next event has the same shape.",
          quality: "poor",
        },
        {
          id: "vendor-sla",
          label: "Rely on the provider's SLA and recovery process for regional services.",
          consequence:
            "The provider does recover, but on its own timeline. Netflix's applications were healthy and unable to receive traffic for hours, which is still an outage for customers.",
          quality: "poor",
        },
      ],
      debrief:
        "Netflix was designed for the failure of all or part of one availability zone, running across three zones and operating with no loss of functionality on two. That model did not cover the ELB control plane, which is regional and failed across all zones. Zonal isolation answers where compute runs, not which shared regional services every request must cross. The gap was in the dependency map.",
    },
    {
      id: "healthy-but-unreachable",
      prompt:
        "Your instances are healthy, the application responds when requests reach it, but ELBs are not forwarding traffic. What do you do?",
      options: [
        {
          id: "preserve-and-verify",
          label:
            "Preserve capacity, stop changing the path, verify where traffic is dropped, and communicate impact.",
          consequence:
            "The team avoids adding churn to a control plane that is already being repaired. Attention stays on the actual break: load-balancer state, not application health.",
          quality: "good",
        },
        {
          id: "replace-instances",
          label: "Replace the instances behind the affected load balancers.",
          consequence:
            "The instances are not the failure. Replacing them adds work, can remove capacity that is still serving some devices, and does not restore the missing ELB configuration.",
          quality: "poor",
        },
        {
          id: "dns-cutover",
          label: "Switch DNS to another region immediately, whether or not that region has a tested ingress path.",
          consequence:
            "A cross-region cutover can restore service if the path exists and has capacity. Done ad hoc, it can move the outage rather than end it; Netflix had not yet built this capability.",
          quality: "mixed",
        },
      ],
      debrief:
        "The instinct to treat an unreachable service as a broken service is usually right, but not when the control plane that routes to it is the failing component. Netflix's applications kept responding whenever requests arrived. Replacing instances would have produced activity without recovery. The useful diagnostic is whether the request ever reaches the application, and that requires a signal from the load-balancer path, not just host health.",
    },
    {
      id: "regional-resilience",
      prompt:
        "The provider will fix its control plane. What should Netflix build so the next regional failure is survivable?",
      options: [
        {
          id: "isthmus",
          label:
            "Build a remote-region ingress layer, automate DNS changes, and test the cutover with real traffic.",
          consequence:
            "Traffic can be routed through a second region's ELBs over persistent connections to the same backends. Automation removes the manual DNS step, and a chaos exercise proves the path before an incident.",
          quality: "good",
        },
        {
          id: "full-duplicate",
          label: "Duplicate the entire application stack in a second region and run both active-active immediately.",
          consequence:
            "This is the strongest end state, but it requires cross-region data replication and traffic management that the team does not yet have. Attempting it all at once adds complexity and new failure modes.",
          quality: "mixed",
        },
        {
          id: "wait-for-provider",
          label: "Wait for the provider's safeguards and keep the existing single-region ingress.",
          consequence:
            "Provider fixes reduce the chance of this specific fault, but they do not give Netflix an independent recovery path. The next regional control-plane failure has the same result.",
          quality: "poor",
        },
      ],
      debrief:
        "Netflix built Isthmus: a thin layer of ELBs and a routing layer in a remote region, connected to backend services over persistent connections, with DNS automation through Denominator. It then shifted traffic gradually until roughly half flowed through each US region, and planned a chaos exercise to prove an ELB outage could be survived. The sequence matters: build the path, test it, then depend on it.",
    },
  ],
  postmortem: [
    { type: "h3", text: "What happened" },
    {
      type: "p",
      text: "A maintenance process was inadvertently run against production ELB state data and logically deleted part of it. Running load balancers kept forwarding traffic at first because the missing data was not needed for basic request handling. The damage appeared when the control plane tried to modify a load balancer: without complete state, it misconfigured the change. Failures accumulated gradually across a handful of ELBs.",
    },
    { type: "h3", text: "Why the impact looked partial and arbitrary" },
    {
      type: "list",
      items: [
        "Netflix used hundreds of ELBs, each supporting a service or a service version, so only some device paths were affected.",
        "Groups of similar devices tended to depend on specific ELBs, which is why consoles and some mobile devices failed while others kept working.",
        "Devices already streaming often continued, because the failure affected new requests and startup rather than every in-flight session.",
        "Netflix's applications and most other AWS services were healthy, so the outage was in the delivery path rather than in compute.",
      ],
    },
    { type: "h3", text: "What changed" },
    {
      type: "list",
      items: [
        "AWS required per-incident change-management approval for production ELB state data instead of persistent developer access.",
        "AWS revised its recovery process and said it would reprogram control-plane workflows to reconcile central state with running load balancers.",
        "Netflix built a remote-region ingress path with automated DNS changes and began running traffic active-active across two US regions.",
        "Netflix planned chaos testing of an ELB outage to verify the new path rather than assuming it worked.",
      ],
    },
    { type: "h3", text: "What generalizes" },
    {
      type: "p",
      text: "Availability-zone isolation is necessary but not sufficient. A regional control plane can fail while every zone and every instance remains healthy. The dependency map has to include the services that configure routing, not only the services that process requests. If the control plane cannot describe where traffic should go, the data plane's health is irrelevant to the customer.",
    },
    {
      type: "p",
      text: "Recovery time is set by the slowest layer in the repair path. Here it was restoring and reconciling control-plane state, not restarting applications. Teams should ask how long it takes to rebuild the configuration that makes their healthy capacity reachable, and whether they can route around it without waiting for the provider.",
    },
    {
      type: "callout",
      tone: "info",
      title: "Not every device went dark",
      body: "Netflix describes a partial outage, not a blackout. The website stayed up, Mac and PC streaming was only slightly reduced, and in-flight playback often continued. A single aggregate availability number would hide which device paths failed.",
    },
  ],
  sources: [
    {
      title: "A Closer Look at the Christmas Eve Outage",
      url: "https://netflixtechblog.com/a-closer-look-at-the-christmas-eve-outage-d7b409a529ee",
      publisher: "Netflix Technology Blog",
      kind: "postmortem",
      note: "Netflix's account of customer impact and the architecture changes that followed.",
    },
    {
      title: "Summary of the December 24, 2012 Amazon ELB Service Event in the US-East Region",
      url: "https://aws.amazon.com/message/680587/",
      publisher: "Amazon Web Services",
      kind: "postmortem",
      note: "Primary source for the control-plane failure, recovery clock, and AWS corrective actions.",
    },
    {
      title: "Isthmus: Resiliency Against ELB Outages",
      url: "https://netflixtechblog.com/isthmus-resiliency-against-elb-outages-d9e0623484f3",
      publisher: "Netflix Technology Blog",
      kind: "docs",
      note: "Describes the remote-region ingress design and DNS automation built after the outage.",
    },
  ],
};
