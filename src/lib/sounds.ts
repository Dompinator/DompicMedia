import { getSoundPreference } from './utils';

export type SoundName =
  | 'startup'
  | 'click'
  | 'leave_call'
  | 'join_call'
  | 'mute'
  | 'camera'
  | 'post'
  | 'like';

let soundsMap: Partial<Record<SoundName, string>> = {};
let loadPromise: Promise<Partial<Record<SoundName, string>>> | null = null;

export async function loadSoundsManifest(force = false): Promise<Partial<Record<SoundName, string>>> {
  if (loadPromise && !force) return loadPromise;
  loadPromise = fetch('/api/sounds')
    .then(async (res) => {
      if (!res.ok) return {};
      const data = (await res.json()) as { sounds?: Partial<Record<SoundName, string>> };
      soundsMap = data.sounds || {};
      return soundsMap;
    })
    .catch(() => ({}));
  return loadPromise;
}

export function getSoundUrl(name: SoundName): string | null {
  return soundsMap[name] || null;
}

export function playSound(name: SoundName, forceEnabled?: boolean): boolean {
  const enabled = forceEnabled !== undefined ? forceEnabled : getSoundPreference();
  if (!enabled) return false;

  const url = soundsMap[name];
  if (!url) return false;

  try {
    const audio = new Audio(url);
    audio.volume = name === 'click' ? 0.35 : 0.6;
    audio.play().catch(() => {});
    return true;
  } catch {
    return false;
  }
}
