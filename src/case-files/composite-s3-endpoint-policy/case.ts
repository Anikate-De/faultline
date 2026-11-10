import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Private S3 access blocked by a VPC endpoint policy",
  accuracyNote:
    "This is an original composite scenario and not a real incident. It combines common gateway-endpoint, IAM, bucket-policy, and backup-permission failure modes into one representative case. It does not describe any company's architecture, traffic, dates, or internal decisions. All times and telemetry are illustrative.",
  timeline: [
    {
      at: "T-14 days",
      title: "Endpoint access is tightened",
      body: "A security review replaces a broad S3 gateway endpoint policy with an allowlist. The new policy permits reads for an analytics bucket and omits the backup bucket's write actions. The route table still points the S3 prefix list at the endpoint.",
      tone: "info",
    },
    {
      at: "T+00:00",
      title: "The nightly backup starts",
      body: "A job in a private subnet begins uploading a database dump. After the first few megabytes, the SDK receives HTTP 403 AccessDenied. The job's retry loop repeats the same request and exhausts its attempt budget.",
      tone: "warn",
    },
    {
      at: "T+00:35",
      title: "The obvious layers look correct",
      body: "On-call checks the instance role and the bucket policy. Both allow the backup prefix. A test from a public subnet succeeds because that path uses a NAT gateway and never traverses the restrictive endpoint.",
      tone: "info",
    },
    {
      at: "T+01:10",
      title: "The private path is isolated",
      body: "The failure reproduces only in the private subnet. An HTTPS request to S3 completes quickly with 403, which rules out a missing route or a security-group block and points to an authorization layer.",
      tone: "info",
    },
    {
      at: "T+01:35",
      title: "The endpoint policy is found",
      body: "The gateway endpoint policy allows GetObject on one bucket but does not allow PutObject, ListBucket, or the multipart actions the backup uses. The endpoint's implicit deny blocks the request even though the identity and bucket policies allow it.",
      tone: "danger",
    },
    {
      at: "T+02:10",
      title: "The policy is corrected",
      body: "The team adds the backup bucket's object ARN for write and multipart actions, the bucket ARN for ListBucket, and a condition restricting use to the expected role. The backup completes on the next run.",
      tone: "success",
    },
    {
      at: "T+2 days",
      title: "The path gets a canary",
      body: "A synthetic job writes and deletes a small object every fifteen minutes from each private subnet. The endpoint policy is now managed as code, and a denied canary write blocks the change before it reaches production.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "where-to-look",
      prompt:
        "The backup gets 403 only from the private subnet, while the instance role and bucket policy both allow the write. What do you check next?",
      options: [
        {
          id: "all-gates",
          label:
            "Compare the identity policy, bucket policy, and VPC endpoint policy, then confirm which path the request actually takes.",
          consequence:
            "The endpoint policy is identified as the denying layer. The team also confirms that the public-subnet success was a different network path, which explains the subnet-specific behavior.",
          quality: "good",
        },
        {
          id: "rotate-keys",
          label: "Rotate the instance credentials and retry.",
          consequence:
            "The role is already valid, so rotation changes nothing except adding a credential event during an incident. The 403 persists and the team loses time on an unrelated hypothesis.",
          quality: "poor",
        },
        {
          id: "open-bucket",
          label: "Loosen the bucket policy to allow the whole VPC.",
          consequence:
            "The bucket policy was not the blocker. Making it broader weakens access control without fixing the endpoint deny, and it may create a new exposure that outlives the incident.",
          quality: "poor",
        },
      ],
      debrief:
        "Private S3 access has several independent gates: the route must exist, the endpoint policy must allow the action, the identity policy must allow it, and the bucket policy must allow it. A 403 that arrives quickly is an authorization result, not a routing timeout. Comparing the layers and the actual path prevents the common mistake of fixing the layer that already looks correct.",
    },
    {
      id: "lasting-control",
      prompt: "How should the team prevent the next endpoint-policy change from breaking backups silently?",
      options: [
        {
          id: "policy-as-code-canary",
          label:
            "Manage endpoint policies as code, test the exact backup actions, and run a private-path canary with alerting.",
          consequence:
            "A missing action or ARN fails in review or in the canary before the nightly job. The policy stays least-privilege and the private path has continuous evidence that it works.",
          quality: "good",
        },
        {
          id: "allow-all",
          label: "Allow s3:* on the endpoint for all principals in the VPC.",
          consequence:
            "The backup recovers immediately, but the endpoint stops providing a meaningful boundary. Any compromised workload in the VPC can reach every bucket the identity policy permits.",
          quality: "poor",
        },
        {
          id: "use-nat",
          label: "Remove the gateway endpoint and send S3 traffic through NAT.",
          consequence:
            "The policy no longer blocks the job, but the organization pays for NAT processing and loses the private-path control. The change also increases the blast radius if the NAT route is unavailable.",
          quality: "mixed",
        },
      ],
      debrief:
        "An endpoint policy is a security boundary, so the fix is not to remove it but to make it testable. The test must exercise the real action set, including multipart upload and listing, against the real bucket and role. A periodic canary catches drift that static review misses, and policy-as-code makes the diff visible. Keep a documented break-glass path, but do not make broad access the default.",
    },
  ],
  postmortem: [
    { type: "h3", text: "What happened" },
    {
      type: "p",
      text: "A gateway endpoint policy was narrowed to an allowlist that did not include the backup bucket's write actions. The route to S3 remained in place, so connections reached the service, but the endpoint denied the requests. The identity role and bucket policy were correct, and a public-subnet test succeeded over NAT, which made the failure look inconsistent until the private path was isolated.",
    },
    { type: "h3", text: "What made it worse" },
    {
      type: "list",
      items: [
        "The endpoint policy was changed without a test that exercised the backup's full action set.",
        "The backup used multipart upload, adding actions that a simple PutObject review would miss.",
        "Public-subnet success was treated as proof that credentials and bucket policy were fine for every path.",
        "The job retried a deterministic 403, extending the failure window without changing the outcome.",
        "No canary watched private S3 access between nightly runs.",
      ],
    },
    { type: "h3", text: "What changed" },
    {
      type: "list",
      items: [
        "Endpoint policies are generated from code and reviewed with the workloads that depend on them.",
        "The backup's action list includes object writes, listing, and multipart operations on the correct ARNs.",
        "A canary writes and deletes a small object from each private subnet and alerts on denial.",
        "Backup errors classify 403 separately from timeouts and stop retrying deterministic authorization failures.",
      ],
    },
    { type: "h3", text: "What generalizes" },
    {
      type: "p",
      text: "A route proves reachability, not permission. Gateway endpoint policies, identity policies, and bucket policies are separate gates, and the most restrictive one wins. Troubleshooting should establish the path first, then walk every authorization layer. The durable fix is to test the workload's real actions through the real path, because a policy that looks reasonable in review can still omit the one action a backup needs.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, error rates, and policy details in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "Gateway endpoints for Amazon S3",
      url: "https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints-s3.html",
      publisher: "Amazon Web Services",
      kind: "docs",
      note: "Gateway endpoint routing and policy behavior for S3.",
    },
    {
      title: "Control access to VPC endpoints using endpoint policies",
      url: "https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints-access.html",
      publisher: "Amazon Web Services",
      kind: "docs",
      note: "How endpoint policies combine with IAM and resource policies.",
    },
    {
      title: "Uploading and copying objects using multipart upload",
      url: "https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html",
      publisher: "Amazon Web Services",
      kind: "docs",
      note: "Multipart upload actions and permissions.",
    },
  ],
};
