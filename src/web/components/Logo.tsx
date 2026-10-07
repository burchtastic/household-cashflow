import { useId } from 'react';

/** The mark: the balance dips toward the floor, clears it, and climbs. Same as public/favicon.svg. */
export function Logo({ size = 28 }: { size?: number }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="logo">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1e40af" />
          <stop offset="0.55" stopColor="#2a78d6" />
          <stop offset="1" stopColor="#10b981" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill={`url(#${id})`} />
      <path d="M9 49H55" stroke="#fff" strokeOpacity=".55" strokeWidth="3" strokeLinecap="round" strokeDasharray="4 8" />
      <path
        d="M9 27C16 14 23 16 28 28C32 38 35 44.5 40 44C46 43.5 50 27 53.5 16"
        fill="none" stroke="#fff" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round"
      />
      <circle cx="53.5" cy="16" r="5.5" fill="#fff" />
      <circle cx="53.5" cy="16" r="2.4" fill="#10b981" />
    </svg>
  );
}

/** Mark plus name. */
export function Wordmark({ size = 28 }: { size?: number }) {
  return (
    <span className="brand">
      <Logo size={size} />
      <span>Cash<span className="brand-flow">flow</span></span>
    </span>
  );
}
