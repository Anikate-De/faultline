import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Scheduled capacity action racing a demand surge",
  accuracyNote:
    "This is an original composite scenario, not a real incident and not a real company incident. It combines common scheduled-scaling, autoscaler, and capacity-floor failure modes into one representative scenario. It does not describe any company's architecture, traffic, dates, or internal decisions. All times are relative and all telemetry is illustrative.",
  timeline: [
    {
      at: "T−2 days",
      title: "A routine evening scale-down is scheduled",
      body: "Capacity has followed a predictable weekday curve for months. A schedule lowers the fleet from 40 tasks to 12 at 18:00, matching the average evening trough and saving cost.",
      tone: "info",
    },
    {
      at: "T−15 min",
      title: "Traffic starts to climb",
      body: "A promotion begins to spread. Request rate rises above the seasonal band, but the schedule still reflects the old curve and has no dependency on live demand.",
      tone: "warn",
    },
    {
      at: "T+00:00",
      title: "The schedule removes most of the fleet",
      body: "Desired capacity drops to 12. The autoscaler observes rising CPU, but the scheduled action owns the desired count and the scale-up policy is inside its cooldown window.",
      tone: "danger",
    },
    {
      at: "T+00:06",
      title: "Latency and errors breach the SLO",
      body: "The remaining tasks saturate. Queue time rises faster than CPU because requests wait for limited concurrency. The load balancer begins returning 5xx responses.",
      tone: "danger",
    },
    {
      at: "T+00:14",
      title: "On-call overrides the desired count",
      body: "On-call pauses the schedule and sets a manual floor above the current demand. The autoscaler is left enabled, but its next action is still delayed by the cooldown.",
      tone: "warn",
    },
    {
      at: "T+00:35",
      title: "New capacity becomes ready",
      body: "Tasks start and pass health checks. Latency falls as concurrency recovers, though the queue drains slowly because the surge is still growing.",
      tone: "info",
    },
    {
      at: "T+01:10",
      title: "The fleet stabilizes above the old schedule",
      body: "Traffic peaks well above the historic evening maximum. The schedule remains paused while the team rebuilds the capacity model around a floor rather than an average.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "first-response",
      prompt: "The scheduled scale-down has just removed capacity and errors are rising. What do you do first?",
      options: [
        {
          id: "override-floor",
          label: "Pause the schedule, raise the minimum capacity, and keep the autoscaler enabled.",
          consequence:
            "Capacity returns without a second controller fighting the first. The team restores headroom while preserving dynamic scaling for the rest of the surge.",
          quality: "good",
        },
        {
          id: "disable-autoscaler",
          label: "Disable the autoscaler and set a large fixed capacity.",
          consequence:
            "The immediate capacity problem is addressed, but the fleet no longer follows demand. A fixed guess can be too small for the peak or expensive long after it passes.",
          quality: "mixed",
        },
        {
          id: "wait-cooldown",
          label: "Wait for the cooldown to expire so the autoscaler can react on its own.",
          consequence:
            "The system stays undersized during the steepest part of the ramp. Errors and queue time grow, and the recovery starts from a deeper backlog.",
          quality: "poor",
        },
      ],
      debrief:
        "The first move is to remove the conflicting action and restore a safe floor, not to choose a permanent scaling strategy. A scheduled action and a dynamic policy can both write desired capacity; when they disagree, the system needs an explicit owner and a floor that neither can cross. Manual override is a temporary control, so it should be recorded and removed deliberately.",
    },
    {
      id: "diagnosis",
      prompt: "Which comparison best explains why capacity fell during rising demand?",
      options: [
        {
          id: "desired-vs-demand",
          label: "Overlay desired capacity, actual capacity, and request rate on one timeline.",
          consequence:
            "The scheduled action and the demand ramp become visible as separate events. The team can see that capacity fell by policy, not because tasks failed or a deploy reduced the fleet.",
          quality: "good",
        },
        {
          id: "recent-deploy",
          label: "Assume the most recent deploy reduced the task count and roll it back.",
          consequence:
            "The rollback adds change during an active incident and may remove a healthy version. It also delays the capacity override that the system actually needs.",
          quality: "poor",
        },
        {
          id: "traffic-only",
          label: "Treat the surge as the whole cause and focus only on traffic volume.",
          consequence:
            "The demand is real, but the outage required the scheduled capacity removal. Without naming the interaction, the team may repeat it at the next schedule boundary.",
          quality: "mixed",
        },
      ],
      debrief:
        "A capacity incident usually has two inputs: demand and the policy that sets supply. Looking at request rate alone explains why load rose but not why capacity fell. The desired-capacity history is the missing signal. It also distinguishes a schedule event from an autoscaler bug or a deployment that changed task count.",
    },
    {
      id: "lasting-guardrail",
      prompt: "What guardrail should prevent the next scheduled scale-down from becoming an outage?",
      options: [
        {
          id: "floor-and-owner",
          label: "Set a demand-aware minimum floor, freeze schedules during surges, and give one controller authority.",
          consequence:
            "The schedule can still save cost outside known risk windows, but it cannot remove capacity below the floor. Ownership and freezes prevent two controllers from overwriting each other.",
          quality: "good",
        },
        {
          id: "remove-schedules",
          label: "Remove scheduled scaling and rely entirely on the autoscaler.",
          consequence:
            "The race disappears, but reactive scaling may arrive late for predictable ramps. Cost and startup latency become the new constraints, and the team loses a useful planning tool.",
          quality: "mixed",
        },
        {
          id: "raise-maximum",
          label: "Raise the maximum capacity and leave the schedule unchanged.",
          consequence:
            "A higher ceiling does not stop the floor from dropping to 12. The same race remains, with more room to grow only after the cooldown and startup delay.",
          quality: "poor",
        },
      ],
      debrief:
        "The durable fix is a constraint, not a bigger number. A minimum floor protects availability when a schedule or policy is wrong; a freeze window handles unpredictable demand; single ownership prevents conflicting writes. The floor should be derived from the capacity needed at the SLO, not from the historic average. Schedules can then optimize cost above that floor.",
    },
  ],
  postmortem: [
    {
      type: "h3",
      text: "What happened",
    },
    {
      type: "p",
      text: "A scheduled scale-down reduced the fleet at the same time a demand surge began. The autoscaler saw the load but could not override the schedule immediately because of ownership and cooldown. The remaining tasks saturated, latency rose, and errors followed. Manual intervention restored a floor, but new tasks took time to become ready.",
    },
    {
      type: "h3",
      text: "Why the controls failed",
    },
    {
      type: "list",
      items: [
        "The schedule encoded an average evening curve but had no minimum floor tied to the SLO.",
        "Scheduled and dynamic scaling both wrote desired capacity without a clear owner.",
        "The cooldown delayed the autoscaler's response and was mistaken for a safety mechanism.",
        "Dashboards showed current capacity and traffic separately, not desired capacity against demand.",
      ],
    },
    {
      type: "h3",
      text: "What changed",
    },
    {
      type: "list",
      items: [
        "A minimum capacity floor applies at all times and is reviewed against peak demand.",
        "Schedules are frozen during promotional and incident windows, with an explicit override procedure.",
        "One controller owns desired capacity; the other can only constrain it within approved bounds.",
        "Capacity dashboards show desired, available, and required capacity on a single timeline.",
      ],
    },
    {
      type: "h3",
      text: "What generalizes",
    },
    {
      type: "p",
      text: "Scheduled scaling is a forecast, and forecasts fail at exactly the moments that matter. The safe design lets a schedule reduce cost only above a floor that protects the SLO. Cooldowns limit churn; they do not protect against a demand change. When two systems can change capacity, the incident is usually an ownership problem before it is a tuning problem.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, capacity numbers, and error observations in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "Scheduled scaling for Amazon EC2 Auto Scaling",
      url: "https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-scheduled-scaling.html",
      publisher: "Amazon Web Services",
      kind: "docs",
      note: "Scheduled actions, desired capacity, and interaction with dynamic scaling.",
    },
    {
      title: "Horizontal Pod Autoscaling",
      url: "https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/",
      publisher: "Kubernetes",
      kind: "docs",
      note: "Desired replicas, stabilization windows, and autoscaler behavior.",
    },
    {
      title: "Managing Load",
      url: "https://sre.google/workbook/managing-load/",
      publisher: "Google SRE Workbook",
      kind: "book",
      note: "Capacity planning, load shedding, and overload response.",
    },
  ],
};
