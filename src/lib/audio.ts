/** Sound file support: type detection, validation and playability checks. */

const AUDIO_MIME_BY_EXT: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  weba: 'audio/webm',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  wma: 'audio/x-ms-wma',
  mid: 'audio/midi',
  midi: 'audio/midi',
  amr: 'audio/amr',
  caf: 'audio/x-caf',
};

export const AUDIO_ACCEPT = `audio/*,${Object.keys(AUDIO_MIME_BY_EXT)
  .map((ext) => `.${ext}`)
  .join(',')}`;

export const MAX_SONG_BYTES = 50 * 1024 * 1024; // 50 MB

/** Browsers often report sound files with an empty or odd MIME type, so check the extension too. */
export function resolveMimeType(file: File): string {
  if (file.type.startsWith('audio/')) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  const fromExt = AUDIO_MIME_BY_EXT[ext];
  if (fromExt && (!file.type || /^(application\/(octet-stream|ogg|x-flac)|video\/ogg)$/.test(file.type))) {
    return fromExt;
  }
  return file.type;
}

/** Storage takes the content type from the File itself, so re-wrap it when we corrected the type. */
export function withResolvedType(file: File): File {
  const type = resolveMimeType(file);
  return type === file.type ? file : new File([file], file.name, { type, lastModified: file.lastModified });
}

/** Resolves with the duration in seconds, or null if this browser cannot play the file. */
export function probeAudio(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      audio.removeAttribute('src');
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(null), 10000);
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => finish(Number.isFinite(audio.duration) ? audio.duration : 0);
    audio.onerror = () => finish(null);
    audio.src = url;
  });
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
