import React from 'react';

export function VesperLogoMark({ className = 'w-8 h-8' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <rect width="64" height="64" rx="16" fill="#141824" />
      <rect x="1" y="1" width="62" height="62" rx="15" stroke="rgba(255,255,255,0.12)" strokeWidth="2" />
      {/* Bold geometric DM monogram */}
      <path
        d="M16 19H25C31.5 19 36 24.5 36 32C36 39.5 31.5 45 25 45H16V19Z"
        stroke="#5B7CFA"
        strokeWidth="5.5"
        strokeLinejoin="round"
      />
      <path
        d="M39 45V21L46.5 34L54 21V45"
        stroke="#F3F4F6"
        strokeWidth="4.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
