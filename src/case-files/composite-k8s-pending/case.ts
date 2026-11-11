import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Unschedulable pods during an HPA-driven traffic surge",
  accuracyNote:
    "This is an original composite scenario and not a real incident. It combines common Kubernetes autoscaling, resource-request, and scheduling-constraint failure modes into one representative case. It does not describe any company's architecture, traffic, dates, or internal decisions. All times and telemetry are illustrative.",
  timeline: [
    {
      at: "T+00:00",
      title: "Traffic doubles and the HPA reacts",
      body: "A promotion doubles request rate. The workload runs eight replicas and the HPA targets 60 percent CPU utilization, measured against requests. Running pods cross the target, so the HPA raises desired replicas toward its maximum of twenty.",
      tone: "info",
    },
    {
      at: "T+01:30",
      title: "New pods split into running and Pending",
      body: "Six of the twelve new pods find room on the general node pool. The other six remain Pending. The node CPU chart shows roughly half utilization, suggesting plenty of room.",
      tone: "warn",
    },
    {
      at: "T+02:10",
      title: "Scheduler events name the constraints",
      body: "Describing a Pending pod shows insufficient CPU on the general pool and an untolerated taint on the burst pool. The burst pool is idle between batch jobs but is tainted so that serving workloads cannot land there.",
      tone: "warn",
    },
    {
      at: "T+03:00",
      title: "The HPA stays at maximum",
      body: "The running pods remain above the CPU target, while the Pending pods serve no traffic. The HPA keeps requesting its maximum because the serving set is overloaded. Latency breaches its SLO.",
      tone: "danger",
    },
    {
      at: "T+04:00",
      title: "Raising the maximum adds more Pending pods",
      body: "The first response raises the HPA maximum to thirty. Six more pods are created and stay Pending.",
      tone: "danger",
    },
    {
      at: "T+05:30",
      title: "Existing capacity becomes eligible",
      body: "The team adds the burst-pool toleration and a preferred node affinity for the burst pool, then adds one general node for headroom. The rollout replaces the Pending pods; the new pods carry the toleration and bind to the burst pool, the HPA settles near sixteen replicas, and latency falls.",
      tone: "success",
    },
    {
      at: "T+10:00",
      title: "The surge is absorbed",
      body: "Running replicas match demand, the Pending count returns to zero, and latency returns to the SLO.",
      tone: "success",
    },
    {
      at: "T+1 day",
      title: "Capacity is planned as one model",
      body: "The team ties the HPA maximum to schedulable capacity, adds a Pending-pod alert, and reviews requests, taints, and topology together before the next promotion.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "pending-first-check",
      prompt:
        "Half the new pods are Pending while node CPU looks moderate. What is the first check?",
      options: [
        {
          id: "scheduler-events",
          label:
            "Describe the Pending pods, read the scheduler events, and compare their requests with node allocatable capacity and taints.",
          consequence:
            "The events identify the exact filters: insufficient CPU on the general pool and an untolerated taint on the burst pool. The team can add eligible capacity instead of guessing at the HPA.",
          quality: "good",
        },
        {
          id: "raise-max",
          label: "Raise the HPA maximum so more replicas can be created.",
          consequence:
            "The HPA creates more pods, but they hit the same scheduler filters and remain Pending. The serving set does not grow, and the queue of unschedulable objects gets larger.",
          quality: "poor",
        },
        {
          id: "delete-pods",
          label: "Delete the Pending pods and let the Deployment recreate them.",
          consequence:
            "Replacement pods land under the same constraints. The delete loop adds churn and can briefly reduce capacity.",
          quality: "poor",
        },
      ],
      debrief:
        "Pending is a scheduling verdict, not a load signal. The scheduler filters nodes by requests, taints and tolerations, affinity, and topology, then binds the pod to a node that passes every filter. Node CPU utilization is an observation after the fact; requests are the currency the scheduler spends. Scheduler events are the fastest way to learn which filter rejected every node. The HPA can only change the desired replica count; it cannot make a node eligible.",
    },
    {
      id: "immediate-capacity",
      prompt:
        "The burst pool is idle but tainted for batch work. What is the safest immediate way to add serving capacity?",
      options: [
        {
          id: "unlock-burst",
          label:
            "Add the matching toleration and a preferred node affinity for the burst pool, and add one general node for headroom.",
          consequence:
            "The existing burst capacity becomes eligible without pinning every serving replica there. The rollout replaces the Pending pods, and the general node adds headroom.",
          quality: "good",
        },
        {
          id: "lower-requests",
          label: "Lower CPU requests across the deployment so more pods fit on each node.",
          consequence:
            "More pods may schedule, but the change alters density and burst headroom for every replica. During an incident it is a risky way to force placement, and it may leave the workload overpacked.",
          quality: "mixed",
        },
        {
          id: "remove-taint",
          label: "Remove the taint from the burst pool so every workload can use it.",
          consequence:
            "Serving pods can schedule, but batch jobs and serving workloads now compete for the same nodes. The isolation the taint provided disappears.",
          quality: "mixed",
        },
      ],
      debrief:
        "A taint is a contract: it reserves a pool for a class of work. The intended way to use that pool for serving is a matching toleration plus a preferred node affinity, not removing the contract for everyone. A required selector would pin every replica to the burst pool and strand general-pool headroom. Lowering requests can be valid, but doing it mid-incident changes packing and reduces burst headroom.",
    },
    {
      id: "durable-capacity",
      prompt: "What should make the next surge schedulable?",
      options: [
        {
          id: "capacity-model",
          label:
            "Treat requests, taints, topology, and node-pool limits as one capacity model, cap the HPA at schedulable capacity, and alert on Pending pods.",
          consequence:
            "The autoscaler and scheduler agree on what the cluster can run. Surges either find eligible capacity or raise an actionable alert before latency collapses.",
          quality: "good",
        },
        {
          id: "higher-max",
          label: "Set the HPA maximum higher and rely on the node autoscaler to catch up.",
          consequence:
            "The HPA can request replicas that no node template can satisfy. The node autoscaler may decline to add nodes because of taints, labels, or pool limits, leaving a larger Pending queue.",
          quality: "poor",
        },
        {
          id: "always-burst",
          label: "Move all serving workloads onto the burst pool.",
          consequence:
            "The separate pool stops being a burst reserve. Batch and serving work collide, and the next batch spike consumes the capacity the surge response depends on.",
          quality: "poor",
        },
      ],
      debrief:
        "Autoscaling has two decisions: how many replicas, and where they can run. The HPA owns the first; the scheduler and node pools own the second. A maximum that exceeds schedulable capacity is a promise the cluster cannot keep. The capacity model needs requests, allocatable capacity, taints, topology, and node-pool limits together. A Pending alert closes the loop because it fires when the two decisions disagree.",
    },
  ],
  postmortem: [
    { type: "h3", text: "What happened" },
    {
      type: "p",
      text: "A traffic surge pushed the serving workload above its CPU target, and the HPA scaled toward its maximum. Half of the new pods could not be scheduled. The general pool was full once requests were counted, and the idle burst pool was tainted for batch work. The HPA kept requesting replicas because the running pods were still overloaded, while the Pending replicas added no serving capacity.",
    },
    { type: "h3", text: "What made it worse" },
    {
      type: "list",
      items: [
        "The HPA maximum was set without checking how many replicas the node pools could schedule.",
        "The burst pool had capacity but no toleration on the serving deployment, so the scheduler could not use it.",
        "Node CPU utilization looked moderate, which hid the fact that requests had already consumed the allocatable budget.",
        "There was no alert on Pending pods, so the first signal was latency rather than a scheduling failure.",
      ],
    },
    { type: "h3", text: "What changed" },
    {
      type: "list",
      items: [
        "Serving pods carry a targeted toleration and preferred node affinity for the burst pool, preserving the batch taint for other workloads.",
        "The HPA maximum is derived from schedulable capacity, not the largest replica count the team might want.",
        "A Pending-pod alert fires with the scheduler event message and the affected node pools.",
        "Capacity reviews include requests, taints, topology, and pool limits in one model.",
      ],
    },
    { type: "h3", text: "What generalizes" },
    {
      type: "p",
      text: "Autoscaling is not capacity planning. The HPA changes how many pods the controller wants; the scheduler decides whether those pods can run. Requests are the scheduler's unit of account, taints and affinity define eligibility, and topology decides distribution. A capacity plan that ignores any of these can show free CPU while producing Pending pods.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, replica counts, utilization percentages, and latency values in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "Horizontal Pod Autoscaling",
      url: "https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/",
      publisher: "Kubernetes",
      kind: "docs",
      note: "How the HPA computes desired replicas from metrics and requests.",
    },
    {
      title: "Kubernetes Scheduler",
      url: "https://kubernetes.io/docs/concepts/scheduling-eviction/kube-scheduler/",
      publisher: "Kubernetes",
      kind: "docs",
      note: "Scheduling and binding, filters, and Pending pod behavior.",
    },
    {
      title: "Assigning Pods to Nodes",
      url: "https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/",
      publisher: "Kubernetes",
      kind: "docs",
      note: "Node selectors, affinity, and placement constraints.",
    },
    {
      title: "Taints and Tolerations",
      url: "https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/",
      publisher: "Kubernetes",
      kind: "docs",
      note: "How taints repel pods and how tolerations admit them.",
    },
    {
      title: "Node Autoscaling",
      url: "https://kubernetes.io/docs/concepts/cluster-administration/node-autoscaling/",
      publisher: "Kubernetes",
      kind: "docs",
      note: "How node autoscaling responds to unschedulable pods.",
    },
  ],
};
