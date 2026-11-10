import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "public",
  company: "GitHub",
  date: "July 13, 2020",
  incidentClass: "DNS-dependent image pulls and a prolonged Kubernetes recovery",
  accuracyNote:
    "Verified against GitHub's July 2020 availability report and Kubernetes image-pull documentation. The report gives 08:18 UTC and a 4-hour 25-minute duration, but no intermediate timestamps; middle timeline entries are phases, not measured times. The report says a routine DNS maintenance operation left clusters unable to reach the image registry, and that recovery came after restarting with cached DNS records. It does not publish a DNS record change, a TTL value, a rollback, or a per-resolver recovery curve. The lesson title's TTL framing is therefore used for general DNS-cache reasoning, not asserted as the incident's cause. No telemetry or internal details beyond the report are added.",
  timeline: [
    {
      at: "T+00:00 · 08:18 UTC",
      title: "Pods become unavailable",
      body: "Production Kubernetes pods are marked unavailable after a single container exceeds its memory limit and is terminated. The container is not required for production traffic, but Kubernetes requires every container in a pod to be healthy for the pod to be available.",
      tone: "warn",
    },
    {
      at: "T+00:00 · first replacement",
      title: "The replacement cannot pull its image",
      body: "The container is configured with ImagePullPolicy Always, so every restart fetches a new image. A routine DNS maintenance operation completed earlier leaves the clusters unable to reach the registry, and replacement pods fail to start.",
      tone: "danger",
    },
    {
      at: "T+00:00–T+04:25 · mitigation",
      title: "A redeploy widens the blast radius",
      body: "A redeploy is triggered to mitigate the pod failures. Instead, the failure propagates across production clusters as capacity falls further and services go down.",
      tone: "danger",
    },
    {
      at: "T+04:25 · 12:43 UTC",
      title: "Cached DNS records break the loop",
      body: "Restarting the process with the cached DNS records lets the clusters fetch container images again. GitHub redeploys and recovers its services.",
      tone: "success",
    },
    {
      at: "After recovery",
      title: "Four follow-up areas",
      body: "GitHub names better monitoring of pod restarts, less dependency on the image registry, expanded validation during DNS changes, and a review of Kubernetes deployment policies. A progressive-delivery workstream runs in parallel.",
      tone: "info",
    },
  ],
  decisions: [
    {
      id: "first-check",
      prompt: "Pods are unavailable and replacements will not start. What do you check first?",
      options: [
        {
          id: "check-dns-registry",
          label: "Test DNS resolution and registry reachability from the cluster.",
          consequence:
            "This finds the blocker before more pods are churned. The report says DNS maintenance had left clusters unable to reach the registry.",
          quality: "good",
        },
        {
          id: "broad-redeploy",
          label: "Trigger a broad redeploy to replace the unhealthy pods.",
          consequence:
            "This is what happened, and the report says it increased impact and spread the failure across production clusters.",
          quality: "poor",
        },
        {
          id: "raise-memory",
          label: "Raise the container memory limit.",
          consequence:
            "The memory limit explains why the first container died, but the replacement pods were failing on image pulls. Changing the limit alone does not restore the registry path.",
          quality: "mixed",
        },
      ],
      debrief:
        "There were two failures in sequence: a container hit its memory limit, and the replacement could not fetch an image. The first explains the trigger; the second explains why the system did not self-heal. A redeploy acts on the first while ignoring the second, so it multiplies the number of pods stuck on the same dependency. Checking the dependency path first would have identified the real blocker.",
    },
    {
      id: "recovery-path",
      prompt: "Image pulls are failing after DNS maintenance. Which recovery path do you use?",
      options: [
        {
          id: "cached-dns",
          label: "Restart the process with cached DNS records and restore registry access.",
          consequence:
            "This is the resolution GitHub reports. It let clusters fetch images again and redeploy.",
          quality: "good",
        },
        {
          id: "wait-ttl",
          label: "Wait for the DNS change to age out of every resolver.",
          consequence:
            "Waiting might shorten the window in some environments, but it does not give the cluster a working registry path and leaves pods failing. The report does not describe TTL expiry as the fix.",
          quality: "mixed",
        },
        {
          id: "app-rollback",
          label: "Roll back the application deployment.",
          consequence:
            "The application version was not the blocker. A rollback still requires image pulls and does not repair DNS reachability.",
          quality: "poor",
        },
      ],
      debrief:
        "Recovery actions must target the layer that is actually broken. The pod needed an image; the image pull needed the registry; the registry path needed DNS. Restarting with cached records worked because it supplied a usable resolution path. Waiting for TTLs would only help if the remaining failure were a stale cache, and the public report does not describe that as the cause. This is the difference between a plausible DNS story and the evidence in the source.",
    },
    {
      id: "durable-control",
      prompt: "Which set of controls addresses the failure mode?",
      options: [
        {
          id: "layered-controls",
          label: "Validate DNS changes, reduce registry dependency, and revisit pod deployment policies.",
          consequence:
            "These are the areas GitHub names, plus progressive delivery. They target the dependency and the restart policy, not just the trigger.",
          quality: "good",
        },
        {
          id: "lower-ttl",
          label: "Lower DNS TTLs everywhere.",
          consequence:
            "Lower TTLs can shorten some cache windows, but the report does not identify a TTL as the cause. They would not fix ImagePullPolicy Always or the registry dependency.",
          quality: "mixed",
        },
        {
          id: "disable-restarts",
          label: "Disable automatic pod restarts.",
          consequence:
            "That removes a recovery mechanism and does not make the registry reachable. It also conflicts with Kubernetes' health model.",
          quality: "poor",
        },
      ],
      debrief:
        "A resilient control set covers the trigger, the dependency, and the recovery policy. GitHub's list does that: validate DNS changes before they reach production, reduce the need to reach the registry on every start, and revisit how pods are deployed and restarted. TTL management can be part of a DNS strategy, but it is not a substitute for any of those. The report's own recovery depended on cached records, which shows that cache state can help or hurt depending on the path.",
    },
  ],
  postmortem: [
    { type: "h3", text: "What happened" },
    {
      type: "p",
      text: "A container in a production Kubernetes pod exceeded its memory limit and was terminated. Because the pod required every container to be healthy, the pod was marked unavailable. The replacement should have started within about a minute, but its ImagePullPolicy of Always required a fresh image pull. DNS maintenance completed earlier had left the clusters unable to reach the registry, so the replacement could not start. A redeploy intended as mitigation spread the failure across clusters and took the services down.",
    },
    { type: "h3", text: "What made it worse" },
    {
      type: "list",
      items: [
        "The failing container was not needed for production traffic, but its health still controlled pod availability.",
        "ImagePullPolicy Always turned every restart into a registry dependency.",
        "DNS maintenance removed the registry path without the pod restart path accounting for it.",
        "The first mitigation was a broad redeploy, which multiplied the number of pods that needed the same unreachable image.",
      ],
    },
    { type: "h3", text: "What changed" },
    {
      type: "list",
      items: [
        "Monitoring was expanded so pod restarts would not fail silently in the same pattern.",
        "GitHub began minimizing its dependency on the image registry.",
        "DNS changes received expanded validation.",
        "Kubernetes deployment policies were revisited, alongside a progressive-delivery workstream.",
      ],
    },
    { type: "h3", text: "What the TTL lens adds, and what it does not" },
    {
      type: "p",
      text: "A restored DNS record does not flush caches that already hold the old answer. Recovery can be bounded by the record's TTL, resolver behavior, client caches, and long-lived connections. That is general DNS reasoning and a useful way to plan a rollback; the one-hour figure in the lesson prompt is illustrative, not a GitHub measurement. It is not what the GitHub report describes: the report describes a DNS maintenance operation, a registry that became unreachable, and a recovery that used cached DNS records. The distinction matters because the fix follows the evidence. If the problem is a stale answer, wait or flush; if the problem is a missing path, restore reachability or use a known-good path.",
    },
    { type: "h3", text: "What generalizes" },
    {
      type: "p",
      text: "A pod restart is a deployment, and a deployment can depend on services that have nothing to do with the application image. Health checks that require an image pull can turn one container's memory spike into a fleet-wide outage. Separate the trigger from the blocker, check the dependency path before widening a restart, and reduce the number of things that must be reachable for a pod to become healthy.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Time notation",
      body: "Only 08:18 UTC and the 4-hour 25-minute duration are published. The 12:43 UTC recovery time is arithmetic from those. Middle entries are phases, not measured timestamps, and no telemetry is invented.",
    },
  ],
  sources: [
    {
      title: "GitHub Availability Report: July 2020",
      url: "https://github.blog/news-insights/company-news/github-availability-report-july-2020/",
      publisher: "GitHub Blog",
      kind: "postmortem",
      note: "Official account of the 13 July incident, DNS maintenance, image pulls, and remediation areas.",
    },
    {
      title: "Images",
      url: "https://kubernetes.io/docs/concepts/containers/images/",
      publisher: "Kubernetes Documentation",
      kind: "docs",
      note: "ImagePullPolicy semantics, including Always fetching an image on every start.",
    },
    {
      title: "DNS Infrastructure at GitHub",
      url: "https://github.blog/engineering/infrastructure/dns-infrastructure-at-github/",
      publisher: "GitHub Blog",
      kind: "docs",
      note: "Background on GitHub's DNS architecture and the operational sensitivity of DNS changes.",
    },
  ],
};
