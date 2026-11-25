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

function resolveAssetUrl(raw: string): string {
  if (/^https?:\/\//i.test(raw)) return raw;
  const base = import.meta.env.BASE_URL || '/';
  const cleaned = raw.replace(/^\/+/, '');
  return `${base}${cleaned}`;
}

export async function loadSoundsManifest(force = false): Promise<Partial<Record<SoundName, string>>> {
  if (loadPromise && !force) return loadPromise;

  const base = import.meta.env.BASE_URL || '/';
  loadPromise = (async () => {
    try {
      const apiRes = await fetch(`${base}api/sounds`);
      const isJson = apiRes.headers.get('content-type')?.includes('application/json');
      if (apiRes.ok && isJson) {
        const data = (await apiRes.json()) as { sounds?: Partial<Record<SoundName, string>> };
        const raw = data.sounds || {};
        const resolved: Partial<Record<SoundName, string>> = {};
        for (const [k, v] of Object.entries(raw)) {
          if (v) resolved[k as SoundName] = resolveAssetUrl(v);
        }
        soundsMap = resolved;
        return soundsMap;
      }
    } catch {
      // fall through to static sounds-manifest.json
    }

    try {
      const staticRes = await fetch(`${base}sounds-manifest.json`);
      const isJson = staticRes.headers.get('content-type')?.includes('application/json');
      if (staticRes.ok && isJson) {
        const data = (await staticRes.json()) as { sounds?: Partial<Record<SoundName, string>> };
        const raw = data.sounds || {};
        const resolved: Partial<Record<SoundName, string>> = {};
        for (const [k, v] of Object.entries(raw)) {
          if (v) resolved[k as SoundName] = resolveAssetUrl(v);
        }
        soundsMap = resolved;
        return soundsMap;
      }
    } catch {
      // ignore missing manifest
    }
    return {};
  })();

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
