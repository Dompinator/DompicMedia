import React, { useState } from 'react';

interface AvatarProps {
  src?: string | null;
  name: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}

const SIZE_CLASSES: Record<NonNullable<AvatarProps['size']>, string> = {
  xs: 'w-6 h-6 text-[11px]',
  sm: 'w-8 h-8 text-xs',
  md: 'w-10 h-10 text-sm',
  lg: 'w-14 h-14 text-lg',
  xl: 'w-24 h-24 text-2xl',
};

export function Avatar({ src, name, size = 'md', className = '' }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  const initials = (name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() || '')
    .join('') || '?';

  if (src && !failed) {
    return (
      <img
        src={src}
        alt={name}
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={`${SIZE_CLASSES[size]} rounded-full object-cover bg-[#181C25] border border-white/10 shrink-0 ${className}`}
      />
    );
  }

  return (
    <div
      className={`${SIZE_CLASSES[size]} rounded-full bg-[#1C2233] border border-white/10 text-[#C7D2FE] font-display font-semibold flex items-center justify-center shrink-0 select-none ${className}`}
      aria-label={name}
    >
      {initials}
    </div>
  );
}
