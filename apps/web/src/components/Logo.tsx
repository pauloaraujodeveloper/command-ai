import { useId } from 'react';

/** Marca do Command AI: três órbitas em gradiente azul→verde ao redor de um núcleo. */
export function LogoMark({ size = 28 }: { size?: number }) {
  const uid = useId().replace(/:/g, '');
  const grad = `lg-${uid}`;
  const core = `lc-${uid}`;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden focusable="false" className="shrink-0">
      <defs>
        <linearGradient id={grad} x1="8" y1="86" x2="92" y2="14" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#3b8cff" />
          <stop offset="1" stopColor="#3ddc97" />
        </linearGradient>
        <radialGradient id={core} cx="45%" cy="40%" r="65%">
          <stop offset="0" stopColor="#9ccbff" />
          <stop offset="0.55" stopColor="#3b8cff" />
          <stop offset="1" stopColor="#1d5fd1" />
        </radialGradient>
      </defs>
      <g fill="none" stroke={`url(#${grad})`} strokeWidth="3.2">
        <ellipse cx="50" cy="50" rx="42" ry="16.5" />
        <ellipse cx="50" cy="50" rx="42" ry="16.5" transform="rotate(60 50 50)" />
        <ellipse cx="50" cy="50" rx="42" ry="16.5" transform="rotate(120 50 50)" />
      </g>
      <circle cx="50" cy="50" r="15" fill="none" stroke="#7db6ff" strokeWidth="2.4" strokeDasharray="14 8" strokeLinecap="round" opacity="0.9" />
      <circle cx="50" cy="50" r="9.5" fill={`url(#${core})`} />
      <circle cx="92" cy="50" r="3.6" fill="#3ddc97" />
      <circle cx="8" cy="50" r="3.6" fill="#3b8cff" />
      <circle cx="71" cy="86.4" r="3.6" fill="#3ddc97" />
      <circle cx="29" cy="13.6" r="3.6" fill="#3b8cff" />
      <circle cx="29" cy="86.4" r="3.6" fill="#3b8cff" />
      <circle cx="71" cy="13.6" r="3.6" fill="#3ddc97" />
    </svg>
  );
}

/** Marca + nome. O "Orchestrator" aparece só em telas largas. */
export function Logo({ size = 28, subtitle = false }: { size?: number; subtitle?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <LogoMark size={size} />
      <span className="leading-tight">
        <span className="block font-semibold tracking-tight">Command AI</span>
        {subtitle && <span className="block text-xs tracking-[0.18em] text-muted">Orchestrator</span>}
      </span>
    </span>
  );
}
