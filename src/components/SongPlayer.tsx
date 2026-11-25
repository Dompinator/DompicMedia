import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Headphones, Music, Pause, Play } from 'lucide-react';
import { Post } from '../types';
import { getSupabase } from '../lib/supabase';
import { formatDuration } from '../lib/audio';

// Fresh stream counts, shared so every card showing the same song stays in step.
const liveCounts = new Map<string, number>();
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function publishCount(postId: string, count: number) {
  liveCounts.set(postId, count);
  listeners.forEach((l) => l());
}

let playing: HTMLAudioElement | null = null;

/** A play counts as a stream after 30 seconds of listening, or half of a shorter song. */
export function streamThreshold(duration: number): number {
  return Number.isFinite(duration) && duration > 0 ? Math.min(30, duration / 2) : 30;
}

export function SongPlayer({ post }: { post: Post }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const listened = useRef(0);
  const lastTime = useRef(0);
  const counted = useRef(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(post.song_duration || 0);
  const [failed, setFailed] = useState(false);

  const live = useSyncExternalStore(subscribe, () => liveCounts.get(post.id) ?? 0);
  // Counts only go up, so the larger of the loaded and live values is the newest.
  const streams = Math.max(post.streams_count || 0, live);

  const audioMedia = post.media_urls.find((m) => m.category === 'audio');
  const cover = post.media_urls.find((m) => m.category === 'image');

  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      audio?.pause();
    };
  }, []);

  if (!audioMedia) return null;

  const startNewPlay = () => {
    listened.current = 0;
    counted.current = false;
  };

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) audio.play().catch(() => setFailed(true));
    else audio.pause();
  };

  const handleTimeUpdate = () => {
    const audio = audioRef.current;
    if (!audio) return;
    const now = audio.currentTime;
    const step = now - lastTime.current;
    lastTime.current = now;
    setTime(now);
    // Only time actually heard counts: skip seeks and muted playback.
    if (!audio.paused && !audio.seeking && !audio.muted && audio.volume > 0 && step > 0 && step < 2) {
      listened.current += step;
    }
    if (!counted.current && listened.current >= streamThreshold(audio.duration)) {
      counted.current = true;
      getSupabase()
        .rpc('record_stream', { p_post_id: post.id })
        .then(({ data, error }) => {
          if (!error && typeof data === 'number') publishCount(post.id, data);
        });
    }
  };

  return (
    <div className="mb-3 rounded-xl border border-[#5B7CFA]/30 bg-[#0B0D11] p-3">
      <div className="flex items-center gap-3">
        <div className="w-16 h-16 shrink-0 rounded-lg overflow-hidden bg-[#181E2E] flex items-center justify-center">
          {cover ? (
            <img src={cover.url} alt="" referrerPolicy="no-referrer" className="w-full h-full object-cover" />
          ) : (
            <Music className="w-6 h-6 text-[#7C96FF]" />
          )}
        </div>
        <button
          type="button"
          data-sound-custom="true"
          onClick={toggle}
          disabled={failed}
          aria-label={isPlaying ? `Pause ${post.song_title}` : `Play ${post.song_title}`}
          className="w-10 h-10 shrink-0 rounded-full bg-[#5B7CFA] hover:bg-[#4B6CF0] disabled:opacity-40 text-white flex items-center justify-center"
        >
          {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-white truncate">{post.song_title}</div>
          <div className="text-xs text-[#9CA3AF] truncate">{post.author?.display_name || 'Unknown artist'}</div>
          <div
            className="mt-1 inline-flex items-center gap-1 text-xs text-[#7C96FF]"
            title="A stream counts after 30 seconds of listening, or half of a shorter song"
          >
            <Headphones className="w-3.5 h-3.5" />
            <span className="font-mono tabular-nums">{streams.toLocaleString()}</span>
            <span>{streams === 1 ? 'stream' : 'streams'}</span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 mt-2 text-[11px] font-mono text-[#9CA3AF]">
        <span>{formatDuration(time)}</span>
        <input
          type="range"
          min={0}
          max={duration || 1}
          step={0.1}
          value={Math.min(time, duration || 1)}
          onChange={(e) => {
            const audio = audioRef.current;
            if (!audio) return;
            audio.currentTime = Number(e.target.value);
            lastTime.current = audio.currentTime;
            setTime(audio.currentTime);
          }}
          aria-label="Seek"
          className="flex-1 min-w-0 accent-[#5B7CFA]"
        />
        <span>{formatDuration(duration)}</span>
      </div>

      {failed && (
        <p className="mt-2 text-xs text-[#FCA5A5]">
          This browser cannot play the file.{' '}
          <a href={audioMedia.url} target="_blank" rel="noreferrer" className="underline">
            Download it
          </a>
        </p>
      )}

      <audio
        ref={audioRef}
        src={audioMedia.url}
        preload="none"
        onPlay={(e) => {
          if (playing && playing !== e.currentTarget) playing.pause();
          playing = e.currentTarget;
          lastTime.current = e.currentTarget.currentTime;
          setIsPlaying(true);
        }}
        onPause={() => setIsPlaying(false)}
        onEnded={() => {
          startNewPlay();
          setTime(0);
          setIsPlaying(false);
        }}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={(e) => {
          if (Number.isFinite(e.currentTarget.duration)) setDuration(e.currentTarget.duration);
        }}
        onError={() => setFailed(true)}
      />
    </div>
  );
}
