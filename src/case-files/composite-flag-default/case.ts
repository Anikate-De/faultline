import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Feature flag default exposed an untested path to all users",
  accuracyNote:
    "This is an original composite scenario, not a real incident. It combines common feature-flag, defaults, and rollout failure modes into one representative case. It does not describe any company's architecture, dates, traffic, or internal decisions. All times and telemetry are illustrative.",
  timeline: [
    {
      at: "T+00:00",
      title: "A flag is created with the default on",
      body: "A developer creates a flag in the shared production project to test a new checkout path. The default variation is set to on so the feature works without a targeting rule, and targeting is left empty.",
      tone: "warn",
    },
    {
      at: "T+00:05",
      title: "The call site deploys",
      body: "The release adds an entry point guarded by the flag. When no targeting rule matches, the client serves the flag's default value. Every session now takes the new path.",
      tone: "danger",
    },
    {
      at: "T+00:12",
      title: "The new path concentrates load",
      body: "The feature calls a pricing query that was never exercised at full traffic. The query lacks a supporting index, database CPU reaches its limit, and checkout latency rises for all users, including those who never reach the new feature.",
      tone: "danger",
    },
    {
      at: "T+00:20",
      title: "The kill switch is not immediate",
      body: "On-call turns the flag off, but clients cache configuration for several minutes. The code's local fallback is also on, so sessions that fail to refresh keep evaluating the feature as enabled.",
      tone: "danger",
    },
    {
      at: "T+00:31",
      title: "Exposure finally falls",
      body: "The team forces clients to refresh and watches exposure events rather than the flag's console state. The share of sessions using the new path drops to zero, and checkout errors begin to recover.",
      tone: "warn",
    },
    {
      at: "T+00:50",
      title: "Traffic returns to baseline",
      body: "The pricing query backlog drains. The feature code is later removed from the release and reintroduced behind a staged rollout with an index in place.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "contain-exposure",
      prompt: "The feature is live for everyone and the flag console has been switched off. What do you do next?",
      options: [
        {
          id: "verify-exposure",
          label:
            "Force configuration refresh and confirm the exposure rate reaches zero, then address the slow query.",
          consequence:
            "The team learns that console state is not the same as user exposure. Traffic leaves the new path within minutes, and the database recovers without a redeploy.",
          quality: "good",
        },
        {
          id: "rollback-deploy",
          label: "Roll back the release that added the call site.",
          consequence:
            "The feature eventually disappears, but the rollback takes longer than a flag change and adds a second variable during the outage. Cached clients may keep the feature until their sessions recycle.",
          quality: "mixed",
        },
        {
          id: "second-flag",
          label: "Create an emergency flag around the first flag and turn that one off.",
          consequence:
            "Another configuration layer is introduced while the system is degraded. Its default and cache behavior are untested, so the team cannot say confidently which sessions have the feature.",
          quality: "poor",
        },
      ],
      debrief:
        "A flag switch changes configuration; it does not necessarily change behavior already cached by clients. Containment requires an observable exposure signal and a way to invalidate local state. The console is a control surface, not proof of what users are running.",
    },
    {
      id: "prevent-recurrence",
      prompt: "Which combination would have prevented a default-on flag from reaching all users?",
      options: [
        {
          id: "default-off-staged",
          label:
            "Default new flags to off, require explicit targeting, review production flag changes, and ramp exposure in stages.",
          consequence:
            "A missing or mistaken rule produces no exposure instead of global exposure. The review covers the flag configuration itself, not only the code that calls it, and each ramp step has an exposure signal.",
          quality: "good",
        },
        {
          id: "more-approvals",
          label: "Keep the default on but require two approvals before any production deploy.",
          consequence:
            "Approvals add friction to the release, but reviewers see the application diff and not the external flag configuration. A default-on flag can still pass review and reach everyone.",
          quality: "mixed",
        },
        {
          id: "remove-flags",
          label: "Remove feature flags and ship features with normal deploys.",
          consequence:
            "There is no flag default to misconfigure, but there is also no way to separate deployment from exposure, dark-launch a path, or stop a feature without another release.",
          quality: "poor",
        },
      ],
      debrief:
        "The safe default for an unconfigured flag is off, with code fallbacks that agree. Production flag changes need the same review and audit as code, and exposure should ramp through explicit targeting rather than arrive through an empty rule set. A kill switch must be tested end to end, including client cache behavior.",
    },
  ],
  postmortem: [
    {
      type: "h3",
      text: "What happened",
    },
    {
      type: "p",
      text: "A new flag was created with its default variation on and no targeting rule. The release added a call site, so the default applied to every session. The new path issued an unindexed query at full traffic, degrading checkout for all users. Turning the flag off did not immediately remove exposure because clients cached configuration and the code fallback was also on.",
    },
    {
      type: "h3",
      text: "What made it worse",
    },
    {
      type: "list",
      items: [
        "The flag configuration lived outside the repository, so code review could not see the default or the empty targeting rule.",
        "The client fallback value matched the unsafe default instead of failing closed.",
        "There was no exposure metric, so the team watched the console switch rather than user behavior.",
        "The new query had never run at production cardinality, and no load test covered the enabled path.",
      ],
    },
    {
      type: "h3",
      text: "What changed",
    },
    {
      type: "list",
      items: [
        "New flags default to off, and enabling requires an explicit targeting rule with an owner.",
        "Production flag changes are reviewed and audited like code changes.",
        "Rollouts ramp by percentage with an exposure check and an error-budget gate at each step.",
        "The kill switch is exercised in a game day, including cache invalidation and fallback behavior.",
      ],
    },
    {
      type: "h3",
      text: "What generalizes",
    },
    {
      type: "p",
      text: "Deployment and exposure are separate events, and the gap between them is configuration. A flag's default is a production decision even when it was chosen to make local testing convenient. Safe systems make the unconfigured state harmless, make the enabled state observable, and make the disabled state take effect without a deploy.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, exposure rates, and latency observations in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "Feature Toggles (aka Feature Flags)",
      url: "https://martinfowler.com/articles/feature-toggles.html",
      publisher: "Martin Fowler",
      kind: "docs",
      note: "Toggle categories, default states, and release versus operational flags.",
    },
    {
      title: "Activation Strategies",
      url: "https://docs.getunleash.io/reference/activation-strategies",
      publisher: "Unleash Documentation",
      kind: "docs",
      note: "Targeting rules, gradual rollout, and default behavior when no strategy matches.",
    },
    {
      title: "Flags",
      url: "https://docs.launchdarkly.com/home/flags",
      publisher: "LaunchDarkly Documentation",
      kind: "docs",
      note: "Flag targeting, default variations, and client-side evaluation.",
    },
  ],
};
