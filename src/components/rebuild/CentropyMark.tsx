type CentropyMarkProps = {
  className?: string;
};

export function CentropyMark({ className }: CentropyMarkProps) {
  return (
    <svg className={className} viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <path
        d="M10 39V12.5C10 8.36 13.36 5 17.5 5H35"
        stroke="currentColor"
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M11 21.5H29.5" stroke="currentColor" strokeWidth="6" strokeLinecap="round" />
      <circle cx="37" cy="5" r="4" fill="var(--mark-electric, #7ccbff)" />
      <circle cx="31.5" cy="21.5" r="3.5" fill="var(--mark-violet, #8b76ff)" />
      <path
        d="M25.5 34.5L30.5 39.5L40 28"
        stroke="var(--mark-amber, #ffb05c)"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
