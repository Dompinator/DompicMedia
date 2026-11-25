import React, { useEffect, useState } from 'react';
import { VesperLogoMark } from './VesperLogo';
import { getSoundPreference, playStartupSound } from '../lib/utils';
import { loadSoundsManifest, playSound } from '../lib/sounds';

export function StartupOverlay() {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const enabled = getSoundPreference();

    loadSoundsManifest().then(() => {
      if (!playSound('startup', enabled)) {
        playStartupSound(enabled);
      }
    });

    const timer = window.setTimeout(
      () => {
        setVisible(false);
      },
      reducedMotion ? 400 : 2050
    );

    return () => window.clearTimeout(timer);
  }, []);

  if (!visible) return null;

  return (
    <div
      className="vesper-startup-backdrop fixed inset-0 z-50 flex items-center justify-center bg-[#0B0D11]/95 backdrop-blur-sm pointer-events-none select-none"
      aria-hidden="true"
    >
      <div className="vesper-startup-logo flex flex-col items-center gap-3">
        <VesperLogoMark className="w-20 h-20" />
        <span className="font-display text-lg font-semibold tracking-tight text-white/90">
          DompicMEDIA
        </span>
      </div>
    </div>
  );
}
