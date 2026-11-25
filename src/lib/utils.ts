export const RESERVED_USERNAMES = new Set([
  'admin',
  'administrator',
  'system',
  'root',
  'support',
  'moderator',
  'mod',
  'staff',
  'official',
  'dompic',
  'dompicmedia',
  'vesper',
  'security',
  'help',
  'api',
  'null',
  'undefined',
  'everyone',
  'here',
]);

export const USERNAME_REGEX = /^[a-z0-9_]{3,24}$/;

export function validateUsername(raw: string): { valid: boolean; normalized: string; error?: string } {
  const normalized = raw.trim().toLowerCase();
  if (!USERNAME_REGEX.test(normalized)) {
    return {
      valid: false,
      normalized,
      error: 'Username must be 3–24 characters using lowercase letters, numbers, or underscores.',
    };
  }
  if (RESERVED_USERNAMES.has(normalized)) {
    return {
      valid: false,
      normalized,
      error: 'This username is reserved and cannot be registered.',
    };
  }
  return { valid: true, normalized };
}

export function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  const diffSec = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (diffSec < 45) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatTimeClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB

export const ALLOWED_CHAT_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/mp4',
  'application/pdf',
  'text/plain',
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

export function categorizeMime(mimeType: string): 'image' | 'video' | 'audio' | 'file' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'file';
}

export function validateAttachmentFile(file: File): string | null {
  if (file.size <= 0) return 'File is empty.';
  if (file.size > MAX_ATTACHMENT_BYTES) return 'File exceeds the 25 MB upload limit.';
  if (!ALLOWED_CHAT_MIMES.has(file.type)) {
    return `File type "${file.type || 'unknown'}" is not permitted.`;
  }
  return null;
}

export async function validatePng128x128(file: File): Promise<string | null> {
  if (file.type !== 'image/png') return 'Global emojis must be PNG files.';
  if (file.size > 1024 * 1024) return 'Emoji PNG must be under 1 MB.';
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      if (img.width !== 128 || img.height !== 128) {
        resolve(`Emoji dimensions must be exactly 128x128 pixels (received ${img.width}x${img.height}).`);
      } else {
        resolve(null);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve('Could not decode PNG image.');
    };
    img.src = url;
  });
}

export const BUILTIN_EMOJIS = [
  'laugh',
  'heart',
  'fire',
  'sparkles',
  'cool',
  'shock',
  'cry',
  'thumbsup',
  'rocket',
  'check',
  'crown',
  'wave',
  'party',
  'eyes',
  '100',
  'mindblown',
] as const;

const SOUND_PREF_KEY = 'vesper_startup_sound_enabled';

export function getSoundPreference(): boolean {
  try {
    const val = localStorage.getItem(SOUND_PREF_KEY);
    return val === null ? true : val === 'true';
  } catch {
    return true;
  }
}

export function setSoundPreference(enabled: boolean): void {
  try {
    localStorage.setItem(SOUND_PREF_KEY, String(enabled));
  } catch {
    // ignore storage restriction
  }
}

export function playStartupSound(enabled: boolean): void {
  if (!enabled) return;
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    if (ctx.state === 'suspended') {
      // Browser blocked autoplay before user gesture; close cleanly without spamming retries
      ctx.close().catch(() => {});
      return;
    }

    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.12, now + 0.08);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 1.35);
    master.connect(ctx.destination);

    // Subtle warm fifth chord (C5 + G5 + D6)
    const freqs = [523.25, 783.99, 1174.66];
    freqs.forEach((f, idx) => {
      const osc = ctx.createOscillator();
      const voiceGain = ctx.createGain();
      osc.type = idx === 0 ? 'sine' : 'triangle';
      osc.frequency.setValueAtTime(f, now + idx * 0.04);
      voiceGain.gain.setValueAtTime(idx === 0 ? 0.55 : 0.25, now + idx * 0.04);
      osc.connect(voiceGain);
      voiceGain.connect(master);
      osc.start(now + idx * 0.04);
      osc.stop(now + 1.4);
    });

    setTimeout(() => {
      ctx.close().catch(() => {});
    }, 1600);
  } catch {
    // Autoplay blocked or audio unavailable; fail silently
  }
}
