import { useId, type CSSProperties } from "react";
import type { OrbStatus } from "./BotAvatar";
import "./VelumMark.css";

export interface VelumMarkProps {
  size?: number;
  status?: OrbStatus;
  className?: string;
  style?: CSSProperties;
  title?: string;
}

export default function VelumMark({
  size = 40,
  status = "idle",
  className = "",
  style,
  title,
}: VelumMarkProps) {
  const uid = useId().replace(/:/g, "_");

  return (
    <svg
      viewBox="0 0 256 256"
      width={size}
      height={size}
      className={`velum-mark status-${status} ${className}`.trim()}
      style={style}
      aria-hidden={title ? undefined : "true"}
      role={title ? "img" : undefined}
      aria-label={title}
    >
      {title && <title>{title}</title>}
      <defs>
        {/* Ambient aura glow */}
        <radialGradient id={`aura-${uid}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" className="velum-aura-stop-0" />
          <stop offset="50%" className="velum-aura-stop-50" />
          <stop offset="100%" className="velum-aura-stop-100" stopOpacity="0" />
        </radialGradient>

        {/* Left arm: deep azure to royal blue */}
        <linearGradient id={`left-${uid}`} x1="0%" y1="0%" x2="70%" y2="100%">
          <stop offset="0%" className="velum-left-stop-0" />
          <stop offset="60%" className="velum-left-stop-60" />
          <stop offset="100%" className="velum-left-stop-100" />
        </linearGradient>

        {/* Fold facet: deep shadow creating 3D turnover */}
        <linearGradient id={`fold-${uid}`} x1="0%" y1="100%" x2="100%" y2="0%">
          <stop offset="0%" className="velum-fold-stop-0" />
          <stop offset="100%" className="velum-fold-stop-100" />
        </linearGradient>

        {/* Right arm: crystalline sky blue with translucent glass luminescence */}
        <linearGradient id={`right-${uid}`} x1="0%" y1="100%" x2="100%" y2="0%">
          <stop offset="0%" className="velum-right-stop-0" />
          <stop offset="45%" className="velum-right-stop-45" />
          <stop offset="100%" className="velum-right-stop-100" />
        </linearGradient>

        {/* Specular bevel highlight along the inner facet */}
        <linearGradient id={`spec-${uid}`} x1="0%" y1="100%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.1" />
          <stop offset="50%" stopColor="#ffffff" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#cce5ff" stopOpacity="0.4" />
        </linearGradient>

        {/* Soft bloom filter */}
        <filter id={`bloom-${uid}`} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Layer 0: Ambient state glow aura */}
      <circle cx="128" cy="128" r="105" className="velum-aura-disk" fill={`url(#aura-${uid})`} />

      {/* Layer 1: Orbital Energy Ring (active in working/starting) */}
      <g className="velum-orbit-group">
        <circle cx="128" cy="128" r="118" className="velum-orbit-track" fill="none" strokeWidth="1.5" />
        <circle cx="246" cy="128" r="4.5" className="velum-orbit-satellite" />
        <circle cx="10" cy="128" r="3" className="velum-orbit-satellite-trailing" />
      </g>

      {/* Layer 2: Harmonic wave bloom (in done) */}
      <circle cx="128" cy="128" r="70" className="velum-harmonic-wave" fill="none" strokeWidth="2" />

      {/* Layer 3: Cognitive thought sparks (in thinking) */}
      <g className="velum-sparks-group">
        <circle cx="128" cy="150" r="3" className="velum-spark spark-1" />
        <circle cx="152" cy="115" r="2.5" className="velum-spark spark-2" />
        <circle cx="98" cy="110" r="2" className="velum-spark spark-3" />
      </g>

      {/* Layer 4: Main 3D Faceted V Ribbon */}
      <g className="velum-prism-body" filter={`url(#bloom-${uid})`}>
        {/* Left Arm */}
        <path
          d="M32 44 L86 44 L130 156 L108 214 Z"
          fill={`url(#left-${uid})`}
          className="velum-facet velum-facet-left"
        />

        {/* Bottom Turnover Fold (gives dimensional illusion) */}
        <path
          d="M108 214 L148 214 L130 156 Z"
          fill={`url(#fold-${uid})`}
          className="velum-facet velum-facet-fold"
        />

        {/* Right Glass Arm */}
        <path
          d="M108 214 L130 156 L224 44 L172 44 Z"
          fill={`url(#right-${uid})`}
          className="velum-facet velum-facet-right"
        />

        {/* Specular Edge Highlight on inner crest */}
        <path
          d="M130 156 L172 44"
          fill="none"
          stroke={`url(#spec-${uid})`}
          strokeWidth="3.5"
          strokeLinecap="round"
          className="velum-specular-edge"
        />
      </g>
    </svg>
  );
}
