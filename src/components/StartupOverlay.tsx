import React, { useEffect, useRef, useState } from 'react';
import { VesperLogoMark } from './VesperLogo';
import { getSoundPreference } from '../lib/utils';
import { loadSoundsManifest, playSound, preloadSounds } from '../lib/sounds';

export function StartupOverlay() {
  const [visible, setVisible] = useState(true);
  const [started, setStarted] = useState(false);
  const startedRef = useRef(false);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;

    // Prepare the audio without starting the visual intro.
    void loadSoundsManifest().then(() => {
      if (active) preloadSounds();
    });

    const startWebsite = () => {
      if (!active || startedRef.current) return;
      startedRef.current = true;
      setStarted(true);

      // The first click/tap/key press starts the visual sequence and sound together.
      if (getSoundPreference()) {
        window.setTimeout(() => playSound('startup'), 80);
      }

      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      timer = window.setTimeout(() => {
        if (active) setVisible(false);
      }, reducedMotion ? 400 : 2050);
    };

    // Capture the very first interaction anywhere on the page.
    window.addEventListener('pointerdown', startWebsite, true);
    window.addEventListener('keydown', startWebsite, true);

    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener('pointerdown', startWebsite, true);
      window.removeEventListener('keydown', startWebsite, true);
    };
  }, []);

  if (!visible) return null;

  return (
    <div
      className={`vesper-startup-backdrop fixed inset-0 z-[9999] flex items-center justify-center bg-[#0B0D11]/95 backdrop-blur-sm select-none ${started ? 'vesper-startup-running' : 'vesper-startup-waiting'}`}
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
