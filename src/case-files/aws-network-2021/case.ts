import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "public",
  company: "Amazon Web Services (AWS)",
  date: "December 7, 2021",
  incidentClass: "Congestion on the internal AWS network between foundational services and the main network",
  accuracyNote:
    "Verified against AWS's public post-event summary for December 7, 2021: the 7:30 AM PST scaling trigger, the connection surge and congestion, the 9:28 AM DNS workaround, the 1:34 PM improvement, the 2:22 PM device recovery, the dependent-service timelines, and AWS's stated remediations. AWS states that customer workloads were not directly impacted by the internal network issue; impact reached customers through affected AWS service control planes and dependencies. This file preserves that distinction and does not claim a customer data-plane outage. The report does not disclose device counts, traffic volumes, customer error percentages, or the identity of the scaling service, so none are asserted here. What remains uncertain is the magnitude of customer impact beyond the service timelines AWS reports. Relative times are derived from PST milestones.",
  timeline: [
    {
      at: "T+00:00",
      title: "An automated scaling action triggers a connection surge",
      body: "At 7:30 AM PST, an automated activity to scale capacity for a service in the main AWS network triggers unexpected behavior from many clients inside the internal network. The resulting connection surge overwhelms the networking devices between the internal network and the main network.",
      tone: "danger",
    },
    {
      at: "T+00:03",
      title: "Control-plane APIs begin to slow",
      body: "By 7:33 AM PST, EC2 APIs for launching and describing instances show increased errors and latency. Route 53 APIs are also impaired, and customers experience console login failures during the event. Existing EC2 instances continue to run.",
      tone: "warn",
    },
    {
      at: "T+01:58",
      title: "DNS errors recover, but congestion remains",
      body: "Operators initially identify elevated internal DNS errors from logs, because real-time monitoring is impaired. At 9:28 AM PST, they finish moving internal DNS traffic away from the congested paths. DNS resolution recovers, and several services improve, but the congestion and the broader service impact remain.",
      tone: "info",
    },
    {
      at: "T+05:05",
      title: "EventBridge delivery is paused to reduce load",
      body: "At 12:35 PM PST, as part of deliberate load reduction, operators disable EventBridge event delivery. Delivery is re-enabled at 2:35 PM, and event latency remains elevated while the backlog drains.",
      tone: "warn",
    },
    {
      at: "T+06:04",
      title: "Congestion improves significantly",
      body: "After isolating top traffic sources, disabling heavy network services, and adding capacity, AWS reports congestion significantly improved by 1:34 PM PST.",
      tone: "info",
    },
    {
      at: "T+06:52",
      title: "Network devices fully recover",
      body: "All network devices are fully recovered by 2:22 PM PST, and console access is restored. Some dependent services, including STS, continue to recover afterward.",
      tone: "success",
    },
    {
      at: "T+08:58",
      title: "STS returns to normal",
      body: "STS latency for OIDC identity-provider credentials had caused login failures for services such as Redshift. AWS reports full STS recovery at 4:28 PM PST.",
      tone: "info",
    },
    {
      at: "T+11:10",
      title: "The EventBridge backlog clears",
      body: "EventBridge delivery latency remains elevated until 6:40 PM PST as it processes the backlog of events accumulated while delivery was paused.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "dns-hypothesis",
      prompt: "Logs show elevated internal DNS errors, but monitoring is degraded. What is your working hypothesis?",
      options: [
        {
          id: "dns-symptom",
          label: "Treat DNS errors as a symptom of congestion and move DNS traffic off the affected path while continuing to look for the source.",
          consequence:
            "DNS resolution recovered by 9:28 AM and several services improved, but congestion remained. The team avoided closing on a partial explanation.",
          quality: "good",
        },
        {
          id: "dns-root",
          label: "Declare DNS the root cause and stop after DNS recovers.",
          consequence:
            "The underlying congestion persists, monitoring stays impaired, and services continue to fail through other paths.",
          quality: "poor",
        },
        {
          id: "dns-restart",
          label: "Restart the DNS fleet as the first action.",
          consequence:
            "This adds change and load without addressing the congested devices. The report says DNS traffic was moved, not that the DNS fleet was restarted.",
          quality: "poor",
        },
      ],
      debrief:
        "A symptom can be real and still not be the cause. The report says operators initially identified elevated internal DNS errors because logs were the available signal. Moving DNS traffic reduced load and restored resolution, but did not clear congestion. Good incident practice is to state what a fix proves: resolution recovering proves the DNS path improved, not that the network is healthy.",
    },
    {
      id: "mitigation-without-monitoring",
      prompt: "Real-time monitoring is unavailable and the congestion is still active. How do you mitigate?",
      options: [
        {
          id: "controlled-load-reduction",
          label: "Identify top traffic sources, isolate them to dedicated devices, disable heavy services deliberately, and add network capacity.",
          consequence:
            "This matches the documented remediation. Progress was slow because monitoring and deployment systems were impaired, and because broad changes risked healthy workloads.",
          quality: "good",
        },
        {
          id: "wait-for-monitoring",
          label: "Pause changes until the monitoring plane returns.",
          consequence:
            "The monitoring plane depends on the same internal network. Waiting extends the outage and leaves operators without a feedback loop.",
          quality: "poor",
        },
        {
          id: "broad-restart",
          label: "Restart all services in the region to clear errors.",
          consequence:
            "This creates a restart and retry storm on an already congested path, and risks turning a control-plane incident into a data-plane outage.",
          quality: "poor",
        },
      ],
      debrief:
        "When the observability plane is inside the failure domain, you need pre-existing logs, independent signals, and a change budget. The report describes slow, deliberate remediation because teams could not see the system and because many workloads were still healthy. In that situation, broad action is not a substitute for localization.",
    },
    {
      id: "retry-response",
      prompt: "Client retries are increasing connection attempts against the congested devices. What do you do?",
      options: [
        {
          id: "cap-and-verify",
          label: "Verify that client backoff is actually engaging, then cap retries and add jitter at the edges.",
          consequence:
            "The report says clients had well-tested backoff behavior, but a latent issue prevented adequate backoff during this event. Capping retries reduces the chance that a delay becomes persistent congestion.",
          quality: "good",
        },
        {
          id: "more-retries",
          label: "Increase retries and extend timeouts so requests can ride out the delay.",
          consequence:
            "More connection attempts arrive at already saturated devices; longer timeouts hold resources and deepen the queue.",
          quality: "poor",
        },
        {
          id: "no-retries",
          label: "Disable retries everywhere.",
          consequence:
            "This removes amplification but also removes protection for brief, independent failures. The better target is a bounded budget with jitter, not a binary switch.",
          quality: "mixed",
        },
      ],
      debrief:
        "Retry policy is part of network capacity planning. A backoff implementation that exists but does not engage under the actual failure mode is not a control. The event also shows the difference between a retry that helps an individual request and a retry population that prevents recovery.",
    },
  ],
  postmortem: [
    {
      type: "h3",
      text: "What happened",
    },
    {
      type: "p",
      text: "An automated scaling activity for a service in the main AWS network triggered unexpected behavior from many clients in AWS's internal network. A large surge of connection activity overwhelmed the networking devices between the internal network and the main network. The resulting delays increased latency and errors, which produced more connection attempts and retries, and the congestion became persistent. Real-time monitoring for the operations teams ran through the affected internal network, so the teams had to diagnose with logs and reduced visibility.",
    },
    {
      type: "h3",
      text: "Why it spread",
    },
    {
      type: "list",
      items: [
        "AWS's internal network hosts foundational services including monitoring, internal DNS, authorization, and parts of the EC2 control plane.",
        "The monitoring gap slowed diagnosis, and internal deployment systems were also affected, which slowed remediation.",
        "DNS errors were a real symptom, but fixing DNS did not remove the congestion on the devices between the two networks.",
        "Retries and connection attempts amplified the original delay. The report says client backoff existed but a latent issue prevented it from working adequately.",
      ],
    },
    {
      type: "h3",
      text: "Impact boundary",
    },
    {
      type: "p",
      text: "AWS states that customer workloads were not directly impacted by the internal networking issue. The main network was not affected. Customers were impacted through AWS service control planes and dependencies: EC2 launches, RDS and EMR resource creation, ELB provisioning, Route 53 API changes, console login, STS, CloudWatch monitoring, API Gateway, EventBridge, and container provisioning. Existing EC2 instances, existing load balancers, existing DNS answers, Lambda invocations, and S3 and DynamoDB access were not impacted, although S3 and DynamoDB access through VPC Endpoints was impaired.",
    },
    {
      type: "h3",
      text: "What changed",
    },
    {
      type: "list",
      items: [
        "AWS disabled the scaling activities that triggered the event and said it would not resume them until remediations were deployed.",
        "It was developing a fix for the latent client-backoff issue that prevented adequate backoff during the congestion, with deployment expected over the following two weeks.",
        "It deployed additional network configuration to protect the affected devices in a similar event.",
        "Service teams were working on their own recovery paths, including API Gateway mitigations so servers remain healthy when the internal network is unavailable.",
      ],
    },
    {
      type: "h3",
      text: "What generalizes",
    },
    {
      type: "p",
      text: "A control-plane incident can look like an application outage while the customer data plane is still healthy. Attribution requires mapping which path the failing call actually uses. The event also shows that observability is part of the failure domain: if monitoring shares the congested path, the team loses its feedback loop at the moment it needs it most. Finally, retries are load. A retry policy that works in a test but does not engage under the real failure mode can turn a transient delay into persistent congestion.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Verified scope",
      body: "The trigger, network path, DNS workaround, recovery milestones, service impacts, and remediation items above come from the AWS post-event summary. Customer-level error rates, device counts, and traffic volumes are not disclosed in that report and are omitted here. Relative offsets are computed from the report's PST milestones.",
    },
  ],
  sources: [
    {
      title: "Summary of the AWS Service Event in the Northern Virginia (US-EAST-1) Region",
      url: "https://aws.amazon.com/message/12721/",
      publisher: "Amazon Web Services",
      kind: "postmortem",
      note: "Official post-event summary: congestion cause, DNS response, recovery sequence, service impact, and remediation.",
    },
    {
      title: "Timeouts, retries, and backoff with jitter",
      url: "https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/",
      publisher: "AWS Builders' Library",
      kind: "docs",
      note: "Retry amplification, backoff, jitter, and retry budgets.",
    },
    {
      title: "AWS Fault Isolation Boundaries",
      url: "https://docs.aws.amazon.com/whitepapers/latest/aws-fault-isolation-boundaries/abstract-and-introduction.html",
      publisher: "Amazon Web Services",
      kind: "standard",
      note: "Control-plane and data-plane separation and blast-radius reasoning.",
    },
  ],
};
