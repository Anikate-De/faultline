/* eslint-disable react-refresh/only-export-components -- diagram registry, not a component module */
import type { ReactNode } from "react";

function Box({
  x,
  y,
  w = 100,
  h = 44,
  label,
  detail,
  tone = "var(--border)",
  fill = "var(--raised)",
}: {
  x: number;
  y: number;
  w?: number;
  h?: number;
  label: string;
  detail?: string;
  tone?: string;
  fill?: string;
}) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx="8" fill={fill} stroke={tone} strokeWidth="1.5" />
      <text x={x + w / 2} y={y + (detail ? 18 : 26)} textAnchor="middle" fill="var(--text)" fontSize="11" fontWeight="600">
        {label}
      </text>
      {detail ? (
        <text x={x + w / 2} y={y + 34} textAnchor="middle" fill="var(--muted)" fontSize="9">
          {detail}
        </text>
      ) : null}
    </g>
  );
}

function Arrow({ x1, y1, x2, y2, tone = "var(--faint)", dashed = false }: { x1: number; y1: number; x2: number; y2: number; tone?: string; dashed?: boolean }) {
  return (
    <line
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      stroke={tone}
      strokeWidth="1.5"
      strokeDasharray={dashed ? "4 4" : undefined}
      markerEnd="url(#arrow)"
    />
  );
}

function SvgFrame({ children, label }: { children: ReactNode; label: string }) {
  return (
    <svg viewBox="0 0 640 220" className="h-auto w-full min-w-[560px]" role="img" aria-label={label}>
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--faint)" />
        </marker>
      </defs>
      {children}
    </svg>
  );
}

const requestPath = (
  <SvgFrame label="Request path from client through DNS, CDN, load balancer, service, cache, and database.">
    <Box x={20} y={88} label="Client" detail="request" />
    <Arrow x1={120} y1={110} x2={152} y2={110} />
    <Box x={154} y={88} label="DNS" detail="resolve" />
    <Arrow x1={254} y1={110} x2={286} y2={110} />
    <Box x={288} y={88} label="CDN" detail="edge cache" />
    <Arrow x1={388} y1={110} x2={420} y2={110} />
    <Box x={422} y={88} label="ALB" detail="L7 route" />
    <Arrow x1={522} y1={110} x2={554} y2={110} />
    <Box x={490} y={168} w={100} label="Service" detail="ECS" tone="var(--accent)" />
    <Arrow x1={540} y1={168} x2={540} y2={140} />
    <Box x={490} y={20} w={100} label="Cache / DB" detail="state" />
    <Arrow x1={590} y1={42} x2={600} y2={90} />
    <Arrow x1={490} y1={42} x2={472} y2={90} />
  </SvgFrame>
);

const hotKey = (
  <SvgFrame label="One hot key fans into a single Redis shard while seven shards remain mostly idle.">
    <Box x={20} y={88} w={110} label="Service" detail="60k RPS" />
    <Arrow x1={130} y1={110} x2={180} y2={110} tone="var(--danger)" />
    <Box x={182} y={88} w={100} label="Hot key" detail="45% of reads" tone="var(--danger)" fill="var(--tone-danger-bg)" />
    <Arrow x1={282} y1={110} x2={330} y2={36} tone="var(--danger)" />
    <Arrow x1={282} y1={110} x2={330} y2={78} />
    <Arrow x1={282} y1={110} x2={330} y2={120} />
    <Arrow x1={282} y1={110} x2={330} y2={162} />
    <Box x={332} y={14} w={80} h={44} label="shard 1" detail="92% CPU" tone="var(--danger)" fill="var(--tone-danger-bg)" />
    <Box x={332} y={56} w={80} h={44} label="shard 2" detail="18% CPU" />
    <Box x={332} y={98} w={80} h={44} label="shard 3" detail="17% CPU" />
    <Box x={332} y={140} w={80} h={44} label="shard 4" detail="19% CPU" />
    <Box x={432} y={56} w={80} h={44} label="shard 5" detail="16% CPU" />
    <Box x={432} y={98} w={80} h={44} label="shard 6" detail="18% CPU" />
    <Box x={432} y={140} w={80} h={44} label="shard 7" detail="17% CPU" />
    <Box x={432} y={14} w={80} h={44} label="shard 8" detail="18% CPU" />
    <text x={540} y={112} fill="var(--danger)" fontSize="10" fontWeight="600">
      max shard = capacity
    </text>
  </SvgFrame>
);

const replica = (
  <SvgFrame label="A primary database replicates to one healthy replica and one lagging replica.">
    <Box x={40} y={88} w={120} label="Primary" detail="writer" tone="var(--accent)" />
    <Arrow x1={220} y1={100} x2={320} y2={52} />
    <Arrow x1={220} y1={120} x2={320} y2={168} tone="var(--warn)" dashed />
    <Box x={330} y={30} w={140} label="Replica A" detail="lag 40ms" />
    <Box x={330} y={146} w={140} label="Replica B" detail="lag 8s" tone="var(--warn)" fill="var(--tone-warn-bg)" />
    <text x={490} y={58} fill="var(--success)" fontSize="10">fresh read</text>
    <text x={490} y={174} fill="var(--warn)" fontSize="10">stale read risk</text>
  </SvgFrame>
);

const canary = (
  <SvgFrame label="A canary moves through 5 percent, 25 percent, and 100 percent traffic with a metric gate at each step.">
    <Box x={30} y={88} w={120} label="Stable" detail="95% traffic" />
    <Box x={190} y={88} w={110} label="Canary" detail="5%" tone="var(--accent)" />
    <Arrow x1={140} y1={100} x2={190} y2={100} />
    <Arrow x1={300} y1={100} x2={350} y2={100} />
    <Box x={352} y={88} w={110} label="Canary 25%" detail="gate" tone="var(--accent)" />
    <Arrow x1={462} y1={100} x2={512} y2={100} />
    <Box x={514} y={88} w={100} label="100%" detail="full rollout" tone="var(--warn)" />
    <text x={352} y={160} fill="var(--muted)" fontSize="9">error + latency + capacity gate</text>
    <text x={514} y={160} fill="var(--muted)" fontSize="9">watch the next limit</text>
  </SvgFrame>
);

const vpcPeering = (
  <SvgFrame label="Two VPCs connected by a peering attachment with a route to the peer CIDR.">
    <Box x={20} y={88} w={140} label="VPC A" detail="10.0.0.0/16" />
    <Box x={460} y={88} w={140} label="VPC B" detail="10.20.0.0/16" />
    <Arrow x1={160} y1={110} x2={460} y2={110} tone="var(--accent)" />
    <text x={310} y={100} textAnchor="middle" fill="var(--accent)" fontSize="10" fontWeight="600">pcx attachment</text>
    <text x={310} y={130} textAnchor="middle" fill="var(--muted)" fontSize="9">route target must be active</text>
  </SvgFrame>
);

const vpcPath = (
  <SvgFrame label="A packet path across two VPCs through a transit gateway, with a missing return route.">
    <Box x={20} y={88} w={130} label="VPC A" detail="10.0.0.0/16" />
    <Box x={220} y={88} w={130} label="TGW" detail="hub route table" tone="var(--accent)" />
    <Box x={420} y={88} w={130} label="VPC B" detail="10.1.0.0/16" />
    <Arrow x1={150} y1={100} x2={220} y2={100} />
    <Arrow x1={350} y1={100} x2={420} y2={100} />
    <Arrow x1={420} y1={124} x2={350} y2={124} tone="var(--danger)" dashed />
    <text x={360} y={150} fill="var(--danger)" fontSize="10">no return route</text>
  </SvgFrame>
);

export const DIAGRAMS: Record<string, ReactNode> = {
  "request-path": requestPath,
  "hot-key-shards": hotKey,
  "replica-lag": replica,
  "canary-stages": canary,
  "vpc-path": vpcPath,
  "vpc-peering": vpcPeering,
};

