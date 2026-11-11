import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Ingress outage during a cluster upgrade",
  accuracyNote:
    "This is an original composite scenario and not a real incident. It combines common Kubernetes version-skew, removed-API, disruption-budget, and drain-capacity failure modes into one representative case. It does not describe any company's architecture, traffic, dates, or internal decisions. All times and telemetry are illustrative.",
  timeline: [
    {
      at: "T+00:00",
      title: "Preflight checks only component versions",
      body: "The cluster is one minor release behind. The plan confirms that the control plane and kubelets will stay within the supported version-skew window. It does not scan workload manifests for API versions removed in the target release and does not review disruption budgets for add-ons.",
      tone: "warn",
    },
    {
      at: "T+00:30",
      title: "The control plane upgrade succeeds",
      body: "The API server is upgraded and the old API version used by the ingress controller is no longer served. The controller loses its watch, but the data plane keeps serving the last configuration, so traffic continues without an immediate error.",
      tone: "info",
    },
    {
      at: "T+00:50",
      title: "The first drain removes a controller replica",
      body: "A worker node is drained. One ingress controller pod is evicted and its replacement starts, performs fresh API discovery, and cannot find the removed Ingress version. It enters CrashLoopBackOff. No disruption budget exists to slow the drain.",
      tone: "danger",
    },
    {
      at: "T+01:10",
      title: "A second drain removes another replica",
      body: "The next node is drained before the replacement is healthy. Another controller pod is evicted, and its replacement fails in the same way. One serving replica remains, below the capacity needed at peak.",
      tone: "danger",
    },
    {
      at: "T+01:20",
      title: "Ingress starts returning 503",
      body: "The remaining controller replica saturates. Its request queue grows and ingress returns 503 for a growing share of requests. The data plane did not fail because of a network problem; it ran out of controller capacity.",
      tone: "danger",
    },
    {
      at: "T+01:35",
      title: "Logs point to the API version",
      body: "Controller logs show that the target API version is not served. API discovery confirms the removal. The team stops the rollout before the last serving replica drains.",
      tone: "warn",
    },
    {
      at: "T+01:50",
      title: "A compatible controller restores capacity",
      body: "The team deploys a controller version that uses a supported API, scales it onto undrained nodes, and watches 503s fall. The control plane stays upgraded; the broken add-on is replaced.",
      tone: "success",
    },
    {
      at: "T+03:30",
      title: "The rollout resumes in small steps",
      body: "Node drains restart one at a time with a disruption budget, a surge node, and a check that replacement pods are Ready before the next drain. The upgrade completes without further errors.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "stop-the-rollout",
      prompt:
        "Ingress returns 503 after two nodes drain and the replacement controller pods are crashlooping. What is the first move?",
      options: [
        {
          id: "halt-and-restore",
          label:
            "Halt the drains, deploy a controller version that uses a supported API, and restore replicas on the remaining nodes.",
          consequence:
            "The change that is removing capacity stops, and a compatible controller restores serving capacity. The upgrade can resume later from a known-good point.",
          quality: "good",
        },
        {
          id: "rollback-control-plane",
          label: "Roll the control plane back to the previous minor release.",
          consequence:
            "A rollback is slow, may violate skew against already-upgraded components, and does not fix the workload manifests. It adds risk before the compatibility problem is understood.",
          quality: "mixed",
        },
        {
          id: "add-replicas",
          label: "Scale the existing ingress controller to more replicas.",
          consequence:
            "New pods use the same incompatible API and crashloop. The replica count rises while serving capacity stays at one or zero.",
          quality: "poor",
        },
      ],
      debrief:
        "When a rollout is removing capacity faster than it is replacing it, the first move is to stop the rollout. Restoring a compatible controller addresses the actual failure; adding replicas multiplies a broken startup path. A control-plane rollback can be a last resort, but it is slow and can create new skew with nodes and add-ons that already moved forward.",
    },
    {
      id: "preflight-gap",
      prompt:
        "What should the pre-upgrade gate have included beyond control-plane and kubelet version skew?",
      options: [
        {
          id: "api-pdb-capacity",
          label:
            "Scan workloads and add-ons for removed or deprecated APIs, review disruption budgets, and confirm replacement capacity for every drain.",
          consequence:
            "The ingress controller incompatibility is found before the control plane changes, and the drain plan has a budget and spare capacity. The upgrade becomes a series of reversible steps.",
          quality: "good",
        },
        {
          id: "skew-only",
          label: "Confirm version skew and proceed as planned.",
          consequence:
            "Skew is necessary but not sufficient. The removed API and the missing disruption budget remain invisible until nodes start draining and capacity disappears.",
          quality: "poor",
        },
        {
          id: "backup-only",
          label: "Take an etcd backup and proceed.",
          consequence:
            "A backup helps recovery from control-plane damage, but it does not prevent a workload outage or shorten the path back to serving traffic. The compatibility gap remains.",
          quality: "mixed",
        },
      ],
      debrief:
        "Version-skew policy covers whether components can talk to each other. It does not cover whether a workload uses an API that the new control plane still serves, whether an add-on can be evicted safely, or whether replacements have somewhere to run. Add-ons are workloads and need the same compatibility and disruption review as application services.",
    },
    {
      id: "durable-upgrade",
      prompt: "What should make future cluster upgrades boring?",
      options: [
        {
          id: "staged-pipeline",
          label:
            "Upgrade API clients and API-consuming add-ons first; move node-level add-ons with the node rollout. Canary one node, use disruption budgets and surge capacity, and drain one node at a time.",
          consequence:
            "Compatibility failures appear on a canary node while capacity is intact. Each drain has a budget and a replacement target, so the upgrade can pause safely.",
          quality: "good",
        },
        {
          id: "parallel-drain",
          label: "Upgrade all nodes in parallel during a low-traffic window to finish quickly.",
          consequence:
            "The cluster loses replacement capacity all at once, and a broken add-on has no healthy node to reschedule onto. Speed increases the blast radius and removes the pause point.",
          quality: "poor",
        },
        {
          id: "defer-upgrade",
          label: "Stay on the current minor release until the next hardware refresh.",
          consequence:
            "The cluster drifts further from supported versions and accumulates more API and add-on changes for one future upgrade. Security fixes and support windows become harder to maintain.",
          quality: "poor",
        },
      ],
      debrief:
        "A cluster upgrade is a compatibility change and a capacity change at the same time. The control plane is the visible part; workloads, add-ons, and node drains are where availability is won or lost. API clients and API-consuming add-ons move first; node-level add-ons follow the node rollout. A canary node, disruption budgets, and surge capacity turn a cluster-wide bet into a staged change with a pause button.",
    },
  ],
  postmortem: [
    { type: "h3", text: "What happened" },
    {
      type: "p",
      text: "The control plane was upgraded to the next minor release. The target release no longer served an API version used by the ingress controller. Existing controller pods kept serving the last configuration, so the incompatibility was invisible until nodes were drained. Each drain evicted a controller pod, and each replacement failed API discovery and crashlooped. With no disruption budget, the drains continued until one overloaded replica remained and ingress returned 503.",
    },
    { type: "h3", text: "What made it worse" },
    {
      type: "list",
      items: [
        "Preflight checked version skew but did not scan for APIs removed in the target release.",
        "The ingress controller had no disruption budget, so drains proceeded while replacements were unhealthy.",
        "Node drains ran back-to-back instead of waiting for controller capacity to recover.",
        "The first instinct was to add replicas, which repeated the same incompatible startup path.",
      ],
    },
    { type: "h3", text: "What changed" },
    {
      type: "list",
      items: [
        "Preflight includes an API discovery and deprecation scan for every workload and add-on.",
        "The ingress controller has a disruption budget and a tested replacement path before any drain.",
        "Upgrades use a canary node, one drain at a time, and a surge node for add-on capacity.",
        "API clients and API-consuming add-ons are upgraded before the control plane; node-level add-ons follow the node rollout.",
        "The runbook has explicit pause and rollback criteria based on ready replicas, not only control-plane health.",
      ],
    },
    { type: "h3", text: "What generalizes" },
    {
      type: "p",
      text: "Control-plane success is not workload success. Version skew answers whether components are compatible; it does not answer whether workloads use removed APIs, whether add-ons can be evicted safely, or whether replacements have capacity. An upgrade plan needs all four checks. The safest sequence upgrades compatibility first, proves it on a canary, and removes capacity only as fast as healthy replacements appear.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, replica counts, and error rates in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "Version Skew Policy",
      url: "https://kubernetes.io/releases/version-skew-policy/",
      publisher: "Kubernetes",
      kind: "docs",
      note: "Supported version differences between control plane and kubelets.",
    },
    {
      title: "Upgrading kubeadm clusters",
      url: "https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-upgrade/",
      publisher: "Kubernetes",
      kind: "docs",
      note: "Control-plane and node upgrade sequence.",
    },
    {
      title: "Safely Drain a Node",
      url: "https://kubernetes.io/docs/tasks/administer-cluster/safely-drain-node/",
      publisher: "Kubernetes",
      kind: "docs",
      note: "Eviction, draining, and disruption behavior.",
    },
    {
      title: "Specifying a Disruption Budget for your Application",
      url: "https://kubernetes.io/docs/tasks/run-application/configure-pdb/",
      publisher: "Kubernetes",
      kind: "docs",
      note: "PodDisruptionBudgets and voluntary disruption limits.",
    },
    {
      title: "Deprecated API Migration Guide",
      url: "https://kubernetes.io/docs/reference/using-api/deprecation-guide/",
      publisher: "Kubernetes",
      kind: "docs",
      note: "API versions removed across Kubernetes releases.",
    },
  ],
};
