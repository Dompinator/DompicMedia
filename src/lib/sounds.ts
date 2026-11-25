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

type SoundMap = Partial<Record<SoundName, string>>;

let soundsMap: SoundMap = {};
let loadPromise: Promise<SoundMap> | null = null;
const audioCache = new Map<SoundName, HTMLAudioElement>();

function resolveAssetUrl(raw: string): string {
  if (/^https?:\/\//i.test(raw)) return raw;
  const base = import.meta.env.BASE_URL || '/';
  const cleaned = raw.replace(/^\/+/, '');
  return `${base}${cleaned}`;
}

export async function loadSoundsManifest(force = false): Promise<SoundMap> {
  if (loadPromise && !force) return loadPromise;

  const base = import.meta.env.BASE_URL || '/';
  loadPromise = (async () => {
    // GitHub Pages is static, so /api/sounds is expected to be unavailable there.
    try {
      const response = await fetch(`${base}sounds-manifest.json?v=1`, { cache: 'no-cache' });
      if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
        const data = (await response.json()) as { sounds?: SoundMap };
        const resolved: SoundMap = {};
        for (const [key, value] of Object.entries(data.sounds || {})) {
          if (value) resolved[key as SoundName] = resolveAssetUrl(value);
        }
        soundsMap = resolved;
        return soundsMap;
      }
    } catch {
      // Try the live-server endpoint below.
    }

    try {
      const response = await fetch(`${base}api/sounds`, { cache: 'no-cache' });
      if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
        const data = (await response.json()) as { sounds?: SoundMap };
        const resolved: SoundMap = {};
        for (const [key, value] of Object.entries(data.sounds || {})) {
          if (value) resolved[key as SoundName] = resolveAssetUrl(value);
        }
        soundsMap = resolved;
      }
    } catch {
      // Keep an empty map; callers can retry later.
    }
    return soundsMap;
  })();

  return loadPromise;
}

export function getSoundUrl(name: SoundName): string | null {
  return soundsMap[name] || null;
}

export function preloadSounds(): void {
  for (const name of Object.keys(soundsMap) as SoundName[]) {
    const url = soundsMap[name];
    if (!url || audioCache.has(name)) continue;
    const audio = new Audio(url);
    audio.preload = 'auto';
    audio.volume = name === 'click' ? 0.35 : 0.6;
    audioCache.set(name, audio);
    audio.load();
  }
}

export function playSound(name: SoundName, forceEnabled?: boolean): boolean {
  const enabled = forceEnabled !== undefined ? forceEnabled : getSoundPreference();
  if (!enabled) return false;

  // Use the manifest URL when available, but never make a click sound depend on
  // the manifest request having completed. The audio files are also copied to
  // the site's /Sounds directory during the static build.
  const url = soundsMap[name] || resolveAssetUrl(`Sounds/${name}.mp3`);

  // Reuse the preloaded audio element for every sound, including join_call.
  // This is the same playback path used by leave_call and the other working cues.
  let audio = audioCache.get(name);
  if (!audio || audio.src !== new URL(url, window.location.href).href) {
    audio = new Audio(url);
    audio.preload = 'auto';
    audio.volume = name === 'click' ? 0.35 : 0.6;
    audioCache.set(name, audio);
    audio.load();
  }

  try {
    audio.currentTime = 0;
    void audio.play().catch((error) => {
      console.warn(`[DompicMEDIA] Could not play sound "${name}":`, error);
    });
    return true;
  } catch (error) {
    console.warn(`[DompicMEDIA] Could not play sound "${name}":`, error);
    return false;
  }
}
