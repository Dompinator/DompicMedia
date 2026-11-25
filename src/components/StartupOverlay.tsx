import React, { useEffect, useState } from 'react';
import { VesperLogoMark } from './VesperLogo';
import { getSoundPreference } from '../lib/utils';
import { loadSoundsManifest, playSound, preloadSounds } from '../lib/sounds';

export function StartupOverlay() {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    let startupPlayed = false;
    let active = true;

    // Load and preload files immediately, but wait for a real user gesture before
    // playing startup.mp3. Browsers block audible autoplay on a fresh page load.
    void loadSoundsManifest().then(() => {
      if (active) preloadSounds();
    });

    const playStartupAfterGesture = () => {
      if (startupPlayed) return;
      startupPlayed = true;
      if (getSoundPreference()) {
        window.setTimeout(() => playSound('startup'), 80);
      }
    };

    window.addEventListener('pointerdown', playStartupAfterGesture, true);
    window.addEventListener('keydown', playStartupAfterGesture, true);

    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let timer: number | undefined;

    const startWebsite = () => {
      if (startupPlayed) return;
      playStartupAfterGesture();
      // Keep the blurred startup screen visible until the user starts the site.
      // The actual intro animation then runs for its full duration.
      timer = window.setTimeout(() => setVisible(false), reducedMotion ? 400 : 2050);
    };

    window.removeEventListener('pointerdown', playStartupAfterGesture, true);
    window.removeEventListener('keydown', playStartupAfterGesture, true);
    window.addEventListener('pointerdown', startWebsite, { capture: true, once: true });
    window.addEventListener('keydown', startWebsite, { capture: true, once: true });

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
