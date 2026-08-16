import React from 'react';

/**
 * AmbientBackground
 * ────────────────────────────────────────────────────────────────────────
 * A lightweight, always-running "living intelligence" backdrop for MCIS.
 * Pure CSS + SVG, no external deps, no animation loops in JS — everything
 * is driven by CSS animations so it stays smooth and battery-friendly.
 *
 * Layers (back → front):
 *  1. Aurora field   — slow-drifting radial color blooms (depth)
 *  2. Neural mesh    — SVG nodes + connecting lines that softly pulse,
 *                      evoking memory/synapse activity
 *  3. Data streams   — thin vertical light traces drifting upward
 *  4. Grain / grid   — faint dot grid for structure + a vignette to
 *                      keep foreground content readable
 *
 * This component is purely decorative (aria-hidden, pointer-events: none)
 * and does not read or write any application state.
 */
function AmbientBackground() {
  return (
    <div className="mcis-ambient" aria-hidden="true">
      <div className="mcis-ambient-aurora mcis-ambient-aurora--a" />
      <div className="mcis-ambient-aurora mcis-ambient-aurora--b" />
      <div className="mcis-ambient-aurora mcis-ambient-aurora--c" />

      <svg
        className="mcis-ambient-mesh"
        viewBox="0 0 1440 900"
        preserveAspectRatio="xMidYMid slice"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="mcisLineGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--mcis-mesh-line-a)" />
            <stop offset="100%" stopColor="var(--mcis-mesh-line-b)" />
          </linearGradient>
          <radialGradient id="mcisNodeGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--mcis-mesh-node)" stopOpacity="0.9" />
            <stop offset="100%" stopColor="var(--mcis-mesh-node)" stopOpacity="0" />
          </radialGradient>
        </defs>

        <g className="mcis-mesh-links" stroke="url(#mcisLineGrad)" strokeWidth="1">
          <line x1="120" y1="140" x2="360" y2="260" />
          <line x1="360" y1="260" x2="300" y2="470" />
          <line x1="360" y1="260" x2="620" y2="180" />
          <line x1="620" y1="180" x2="880" y2="300" />
          <line x1="880" y1="300" x2="1150" y2="160" />
          <line x1="880" y1="300" x2="1020" y2="520" />
          <line x1="300" y1="470" x2="560" y2="600" />
          <line x1="560" y1="600" x2="820" y2="560" />
          <line x1="820" y1="560" x2="1020" y2="520" />
          <line x1="1020" y1="520" x2="1260" y2="640" />
          <line x1="120" y1="140" x2="80" y2="380" />
          <line x1="80" y1="380" x2="300" y2="470" />
          <line x1="1150" y1="160" x2="1340" y2="320" />
          <line x1="560" y1="600" x2="480" y2="780" />
        </g>

        <g className="mcis-mesh-nodes" fill="url(#mcisNodeGlow)">
          {[
            [120, 140], [360, 260], [620, 180], [880, 300], [1150, 160],
            [300, 470], [1020, 520], [560, 600], [820, 560], [1260, 640],
            [80, 380], [1340, 320], [480, 780],
          ].map(([cx, cy], i) => (
            <circle key={i} cx={cx} cy={cy} r={i % 3 === 0 ? 26 : 18} className={`mcis-mesh-node mcis-mesh-node--${i % 4}`} />
          ))}
        </g>

        <g className="mcis-mesh-cores" fill="var(--mcis-mesh-node)">
          {[
            [120, 140], [360, 260], [620, 180], [880, 300], [1150, 160],
            [300, 470], [1020, 520], [560, 600], [820, 560], [1260, 640],
            [80, 380], [1340, 320], [480, 780],
          ].map(([cx, cy], i) => (
            <circle key={i} cx={cx} cy={cy} r="2.4" className={`mcis-mesh-core mcis-mesh-core--${i % 4}`} />
          ))}
        </g>
      </svg>

      <div className="mcis-ambient-streams">
        {Array.from({ length: 7 }).map((_, i) => (
          <span key={i} className={`mcis-stream mcis-stream--${i}`} />
        ))}
      </div>

      <div className="mcis-ambient-grid" />
      <div className="mcis-ambient-vignette" />
    </div>
  );
}

export default AmbientBackground;
