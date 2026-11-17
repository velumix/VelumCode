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
        {/* Ambient state aura glow */}
        <radialGradient id={`aura-${uid}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" className="velum-aura-stop-0" />
          <stop offset="50%" className="velum-aura-stop-50" />
          <stop offset="100%" className="velum-aura-stop-100" stopOpacity="0" />
        </radialGradient>

        {/* Left wing outer bevel + recessed sapphire channel */}
        <linearGradient id={`left-${uid}`} x1="12%" y1="15%" x2="50%" y2="90%">
          <stop offset="0%" className="velum-left-stop-0" />
          <stop offset="55%" className="velum-left-stop-60" />
          <stop offset="100%" className="velum-left-stop-100" />
        </linearGradient>

        {/* Recessed core channels */}
        <linearGradient id={`fold-${uid}`} x1="20%" y1="20%" x2="50%" y2="85%">
          <stop offset="0%" className="velum-fold-stop-0" />
          <stop offset="100%" className="velum-fold-stop-100" />
        </linearGradient>

        {/* Right glass wing */}
        <linearGradient id={`right-${uid}`} x1="88%" y1="15%" x2="50%" y2="90%">
          <stop offset="0%" className="velum-right-stop-100" />
          <stop offset="45%" className="velum-right-stop-45" />
          <stop offset="100%" className="velum-right-stop-0" />
        </linearGradient>

        {/* Specular highlight ridge */}
        <linearGradient id={`spec-${uid}`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#e0f2fe" stopOpacity="0.9" />
          <stop offset="50%" stopColor="#ffffff" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#7dd3fc" stopOpacity="0.7" />
        </linearGradient>

        {/* Soft crystal bloom */}
        <filter id={`bloom-${uid}`} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="2.6" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Layer 0: Ambient state glow aura (transparent in UI) */}
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

      {/* Layer 4: Chiseled 3D Crystal V & Cut Diamond Core */}
      <g className="velum-prism-body" filter={`url(#bloom-${uid})`}>
        {/* Top crown bevels */}
        <path d="M24 37H86L73 52.5H43L24 37Z" fill="#bae6fd" />
        <path d="M232 37H170L183 52.5H213L232 37Z" fill="#e0f2fe" />

        {/* Outer luminous bevel flanks */}
        <path d="M24 37L43 52.5L128 204V233L24 37Z" fill={`url(#left-${uid})`} className="velum-facet velum-facet-left" />
        <path d="M232 37L213 52.5L128 204V233L232 37Z" fill={`url(#right-${uid})`} className="velum-facet velum-facet-right" />

        {/* Recessed core channels */}
        <path d="M43 52.5H73L128 163V204L43 52.5Z" fill={`url(#fold-${uid})`} className="velum-facet velum-facet-fold" />
        <path d="M213 52.5H183L128 163V204L213 52.5Z" fill="#1d4ed8" />

        {/* Internal refracted cyan caustics */}
        <path d="M51.5 69H69.5L93 119.5H74L51.5 69Z" fill="#38bdf8" fillOpacity="0.58" />
        <path d="M204.5 69H186.5L163 119.5H182L204.5 69Z" fill="#7dd3fc" fillOpacity="0.62" />

        {/* Inner valley bevel walls */}
        <path d="M86 37L128 140V163L73 52.5L86 37Z" fill="#1e3a8a" />
        <path d="M170 37L128 140V163L183 52.5L170 37Z" fill="#3b82f6" />

        {/* Central keel spears */}
        <path d="M121 187L128 140V233L121 187Z" fill="#7dd3fc" />
        <path d="M135 187L128 140V233L135 187Z" fill="#1e3a8a" />

        {/* Crisp specular facet edges */}
        <path
          d="M24 37L43 52.5L128 204L213 52.5L232 37M86 37L73 52.5L128 163L183 52.5L170 37M128 140V233"
          fill="none"
          stroke={`url(#spec-${uid})`}
          strokeWidth="1.4"
          strokeLinejoin="round"
          className="velum-specular-edge"
        />

        {/* 6-Facet Cut Diamond Core */}
        <path d="M128 34L115.5 73.5L99 71.5Z" fill="#bae6fd" />
        <path d="M128 34L140.5 73.5H115.5Z" fill="#f0f9ff" />
        <path d="M128 34L157 71.5L140.5 73.5Z" fill="#38bdf8" />
        <path d="M99 71.5L115.5 73.5L128 111Z" fill="#7dd3fc" />
        <path d="M115.5 73.5H140.5L128 111Z" fill="#0ea5e9" />
        <path d="M140.5 73.5L157 71.5L128 111Z" fill="#0369a1" />
        <path
          d="M128 34L157 71.5L128 111L99 71.5Z"
          fill="none"
          stroke="#0284c7"
          strokeOpacity="0.55"
          strokeWidth="1"
          strokeLinejoin="round"
        />
        <path
          d="M128 34L115.5 73.5L128 111M128 34L140.5 73.5L128 111M99 71.5L115.5 73.5H140.5L157 71.5"
          fill="none"
          stroke="#ffffff"
          strokeOpacity="0.9"
          strokeWidth="1.1"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}
