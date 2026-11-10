import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "public",
  company: "Slack",
  date: "January 4, 2021",
  incidentClass: "Traffic surge and saturation of a shared network dependency",
  accuracyNote:
    "Verified against Slack's engineering postmortem, published February 1, 2021, and cross-checked with independent reporting. All clock times are the Pacific times stated in the postmortem. The T+ markers order events; they are not minute-precise offsets. Slack does not publish the exact moment packet loss began or the size of the Transit Gateway capacity increase, so those details are omitted rather than estimated. AWS's internal scaling behavior is described only as Slack reported it. Figures such as 1,200 servers and the 10:40 a.m. recovery come directly from the postmortem. No telemetry or quotes are invented.",
  timeline: [
    {
      at: "T+00:00",
      title: "Error rates climb and monitoring fails",
      body: "During the Americas morning, an external monitoring service pages Slack as error rates creep up. While responders are in early triage, the dashboarding and alerting service becomes unavailable: it runs in a different VPC from its backend databases, so it depends on the same Transit Gateways that are losing packets. Responders fall back to direct metric queries, logs, and command-line tools. At 6:57 a.m., 99% of messages are still being sent, far below the normal rate above 99.999%.",
      tone: "danger",
    },
    {
      at: "T+02:00",
      title: "The 7:00 a.m. mini-peak arrives",
      body: "Slack's traffic pattern includes mini-peaks at the top of each hour and half hour, as reminders and external cron jobs fire. The 7:00 a.m. peak, combined with packet loss, saturates the web tier. Latency to backends rises and Slack becomes unavailable.",
      tone: "danger",
    },
    {
      at: "T+02:05",
      title: "Autoscaling moves in both directions",
      body: "Waiting worker threads push CPU utilization down, so the autoscaler removes web hosts. Thread utilization then triggers a large scale-up. Some responders lose their SSH sessions as the instances they are investigating are deprovisioned. Downscaling is disabled.",
      tone: "danger",
    },
    {
      at: "T+02:15",
      title: "The scale-up stalls",
      body: "Slack tries to add 1,200 servers between 7:01 and 7:15 a.m. Provision-service, which configures new instances, is using the same degraded network. It hits the Linux open files limit and an AWS quota, so most new instances never begin serving.",
      tone: "danger",
    },
    {
      at: "T+03:15",
      title: "Provisioning recovers",
      body: "Around 8:15 a.m., provision-service is working again and healthy instances begin to enter service. Broken instances have also consumed the autoscaling group's maximum size, which responders must clear.",
      tone: "info",
    },
    {
      at: "T+04:15",
      title: "Degraded, not down",
      body: "By 9:15 a.m. the web tier has enough functioning hosts. Load balancer panic mode spreads requests across all instances despite failing health checks, and retries plus circuit breaking restore serving. Slack is slower than normal with elevated errors.",
      tone: "success",
    },
    {
      at: "T+05:40",
      title: "The Transit Gateway is resized",
      body: "AWS engineers had already been alerted by their own monitoring and increase the capacity of the overloaded Transit Gateway manually. By 10:40 a.m. the change has rolled out across all Availability Zones, and latency and error rates return to normal.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "autoscaler-during-packet-loss",
      prompt:
        "Packet loss is rising, CPU utilization is falling, and the autoscaler is removing web hosts. What is the first move?",
      options: [
        {
          id: "freeze-scaling",
          label: "Freeze autoscaling and preserve the serving hosts while you diagnose.",
          consequence:
            "The fleet stops losing capacity to a misleading CPU signal. Responders keep the instances they are investigating, and the team can decide on a deliberate scale-up once it knows whether provisioning can succeed.",
          quality: "good",
        },
        {
          id: "trust-autoscaler",
          label: "Let both autoscaling signals act and add capacity aggressively.",
          consequence:
            "The downscale removes healthy serving capacity while the scale-up depends on a provisioning path that uses the same degraded network. Slack tried a large scale-up and most new instances never became usable.",
          quality: "poor",
        },
        {
          id: "raise-minimum",
          label: "Raise the group minimum and leave the scaling policy unchanged.",
          consequence:
            "Minimum size protects some hosts but does not stop the policy from oscillating. It also adds cost without addressing why CPU and thread utilization disagree.",
          quality: "mixed",
        },
      ],
      debrief:
        "CPU is a proxy for work, and blocked threads look idle. During packet loss the autoscaler saw low CPU and high thread utilization at the same time. Freezing the policy is not a permanent fix, but it stops the system from converting a network symptom into lost serving capacity. The scale-up was reasonable but untested at that size over a degraded network.",
    },
    {
      id: "monitoring-dependency",
      prompt:
        "The dashboard and alerting service fails while responders need it most. What should the incident response assume?",
      options: [
        {
          id: "treat-as-dependency",
          label: "Treat monitoring as part of the failing dependency and preserve an independent path to its data.",
          consequence:
            "Responders use direct metric queries and logs rather than waiting for dashboards. The team plans to move the dashboard instances into the same VPC as their databases, removing the Transit Gateway dependency.",
          quality: "good",
        },
        {
          id: "wait-for-dashboards",
          label: "Pause the investigation until dashboards and alerts return.",
          consequence:
            "The incident keeps running while the team loses its main diagnostic surface. Recovery time grows and responders rely on ad hoc queries under pressure.",
          quality: "poor",
        },
        {
          id: "provider-health",
          label: "Rely on the cloud provider's service health dashboard for situational awareness.",
          consequence:
            "Provider status is useful for escalation but too coarse to show which Slack tier is failing or whether a scale-up is working. It cannot replace per-service signals.",
          quality: "poor",
        },
      ],
      debrief:
        "Monitoring is a production dependency and can share fate with the system it observes. Slack's dashboards were in a different VPC from their databases, which turned the Transit Gateway into a dependency of observability. The durable fix is architectural separation plus a documented fallback to raw metrics and logs, not a promise that dashboards will always be available.",
    },
    {
      id: "surge-preparation",
      prompt:
        "The trigger was a managed network component that did not scale fast enough for a predictable annual surge. What follow-up reduces recurrence?",
      options: [
        {
          id: "prewarm-and-test",
          label:
            "Request preemptive capacity before the known surge and load test the provisioning path at the target scale.",
          consequence:
            "The demand pattern is known in advance, so capacity can be arranged before the first workday rather than during it. Load testing exposes the provisioning limits that a steady-state test never reaches.",
          quality: "good",
        },
        {
          id: "trust-managed-scaling",
          label: "Rely on the managed service to scale transparently, as its documentation implies.",
          consequence:
            "The component is designed to scale, but it did not do so fast enough for this packet rate. Treating managed scaling as unconditional leaves the same gap open next year.",
          quality: "poor",
        },
        {
          id: "permanent-headroom",
          label: "Permanently overprovision the web tier so it can absorb any surge.",
          consequence:
            "Extra serving capacity helps with compute but does not fix the network path or the provisioning service. It adds steady cost for a brief, predictable peak.",
          quality: "mixed",
        },
      ],
      debrief:
        "The surge was not a surprise: Slack knew the first Monday after the holidays brought cold client caches and heavier first connections. The gap was that a managed dependency did not scale on the same schedule. Prewarming, load testing the provisioning path, and checking quota and file-descriptor limits convert a known peak into a planned event.",
    },
  ],
  postmortem: [
    { type: "h3", text: "What happened" },
    {
      type: "p",
      text: "A sharp return-to-work surge met an AWS Transit Gateway that could not scale quickly enough. Packet loss spread across Slack's network. At 7:00 a.m. PST the hourly mini-peak, combined with that packet loss, pushed the web tier into saturation, and Slack went from degraded to unavailable. Compute was not the shortage; the network between VPCs was.",
    },
    { type: "h3", text: "What made it worse" },
    {
      type: "list",
      items: [
        "The autoscaler reacted to CPU that fell because threads were blocked, removing serving hosts during the outage.",
        "The emergency scale-up overloaded provision-service, which depended on the same degraded network and hit an open files limit and an AWS quota.",
        "Dashboarding and alerting sat behind the same Transit Gateway as their databases, so the team lost its primary diagnostic tools.",
        "The first workday after the holidays brought cold client caches and heavier first connections, amplifying the demand ramp.",
      ],
    },
    { type: "h3", text: "What changed" },
    {
      type: "list",
      items: [
        "Dashboard instances will run in the same VPC as their databases, removing the Transit Gateway from the monitoring path.",
        "Slack plans to request preemptive Transit Gateway capacity before the next holiday season.",
        "Provision-service will be load tested regularly at surge scale.",
        "Health-check and autoscaling settings will be reviewed to avoid overloading the provisioning path again.",
      ],
    },
    { type: "h3", text: "What generalizes" },
    {
      type: "p",
      text: "A surge does not have to exhaust compute to take a service down. It finds the least elastic shared dependency: a network gateway, a provisioning service, a connection pool, or a control plane. CPU averages can look calm while the system is failing, because blocked work is not busy work. The useful question is not how much headroom the fleet has, but which shared path every request and every recovery action must cross.",
    },
    {
      type: "p",
      text: "Recovery capacity has its own dependency chain. Adding servers only helps if the provisioning path can configure them, and the provisioning path may use the very network that is degraded. Test that chain at the scale you expect to need, including the quota and file-descriptor limits that steady-state traffic never touches.",
    },
    {
      type: "p",
      text: "Client caches were cold, not saturated; the shared limit was the network gateway. The same method applies to a cache or connection pool: locate the shared limit before adding capacity.",
    },
    {
      type: "callout",
      tone: "info",
      title: "No reconstructed telemetry",
      body: "This case uses only figures stated in the public postmortem. It does not invent packet-loss percentages, request rates, or queue depths. The absence of those numbers is deliberate: the public record does not contain them.",
    },
  ],
  sources: [
    {
      title: "Slack's Outage on January 4th 2021",
      url: "https://slack.engineering/slacks-outage-on-january-4th-2021/",
      publisher: "Slack Engineering",
      kind: "postmortem",
      note: "Primary source for the timeline, causes, and follow-up actions.",
    },
    {
      title: "Slack fingers AWS auto-scaling failure in January outage postmortem",
      url: "https://www.theregister.com/off-prem/2021/02/02/slack-fingers-aws-auto-scaling-failure-in-january-outage-postmortem/1530659",
      publisher: "The Register",
      kind: "docs",
      note: "Independent reporting used only to cross-check dates, figures, and sequence.",
    },
    {
      title: "Slack vs TGWs",
      url: "https://downtimeproject.com/podcast/episode-1-slack-vs-tgws/",
      publisher: "The Downtime Project",
      kind: "talk",
      note: "Independent reconstruction of the incident sequence; used for cross-checking.",
    },
  ],
};
