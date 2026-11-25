import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  Radio,
  Video,
  VideoOff,
  Volume2,
} from 'lucide-react';
import { Profile, ServerChannel, VoiceParticipant } from '../types';
import { getActiveSupabaseConfig, getSupabase } from '../lib/supabase';
import { Avatar } from './Avatar';

interface VoiceRoomStageProps {
  channel: ServerChannel;
  currentUser: Profile;
  participants: VoiceParticipant[];
  hidden?: boolean;
  onSpeakingUsersChange?: (userIds: string[]) => void;
  onLeave: () => void;
}

interface RemoteStreamEntry {
  userId: string;
  stream: MediaStream;
}

function RemoteVideoTile({
  participant,
  stream,
  relayFrame,
  speaking,
}: {
  participant?: VoiceParticipant;
  stream?: MediaStream;
  relayFrame?: string;
  speaking: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  const hasWebRtcVideo = Boolean(
    stream && stream.getVideoTracks().some((t) => t.enabled && t.readyState === 'live')
  );
  const showRelayFrame = !hasWebRtcVideo && Boolean(relayFrame);
  const isSpeaking = speaking && !participant?.muted;

  return (
    <div
      className={`relative bg-[#12151C] rounded-2xl overflow-hidden aspect-video flex flex-col items-center justify-center transition-all duration-150 ${
        isSpeaking
          ? 'border-2 border-[#5B7CFA] ring-2 ring-[#5B7CFA]/55 shadow-[0_0_24px_rgba(91,124,250,0.4)]'
          : 'border border-white/10'
      }`}
    >
      {stream && (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          className={
            hasWebRtcVideo
              ? 'w-full h-full object-cover block'
              : 'absolute w-px h-px opacity-0 pointer-events-none'
          }
        />
      )}

      {showRelayFrame && (
        <img
          src={relayFrame}
          alt={participant?.profile?.display_name || 'Video feed'}
          className="w-full h-full object-cover"
        />
      )}

      {!hasWebRtcVideo && !showRelayFrame && (
        <div className="flex flex-col items-center gap-2">
          <div
            className={`rounded-full transition-all duration-150 ${
              isSpeaking ? 'ring-3 ring-[#5B7CFA] ring-offset-2 ring-offset-[#12151C]' : ''
            }`}
          >
            <Avatar
              src={participant?.profile?.avatar_url}
              name={participant?.profile?.display_name || 'Member'}
              size="lg"
            />
          </div>
          <span className="text-xs font-medium text-white">
            {participant?.profile?.display_name || 'Participant'}
          </span>
        </div>
      )}

      <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between px-2.5 py-1 rounded-lg bg-black/65 backdrop-blur-sm text-xs text-white">
        <span className="truncate font-medium flex items-center gap-1.5">
          {isSpeaking && <span className="w-2 h-2 rounded-full bg-[#5B7CFA] shrink-0 animate-pulse" />}
          {participant?.profile?.display_name || participant?.user_id.slice(0, 6)}
        </span>
        <span className="flex items-center gap-1.5 shrink-0">
          {participant?.muted && <MicOff className="w-3.5 h-3.5 text-[#EF4444]" />}
        </span>
      </div>
    </div>
  );
}

export function VoiceRoomStage({
  channel,
  currentUser,
  participants,
  hidden = false,
  onSpeakingUsersChange,
  onLeave,
}: VoiceRoomStageProps) {
  const [muted, setMuted] = useState(false);
  const [videoEnabled, setVideoEnabled] = useState(false);
  const [screenSharing, setScreenSharing] = useState(false);
  const [transportMode, setTransportMode] = useState<'p2p' | 'relay'>('p2p');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<RemoteStreamEntry[]>([]);
  const [relayFrames, setRelayFrames] = useState<Record<string, string>>({});
  const [speakingUsers, setSpeakingUsers] = useState<Record<string, boolean>>({});

  const mutedRef = useRef(false);
  const videoEnabledRef = useRef(false);
  const transportModeRef = useRef<'p2p' | 'relay'>('p2p');
  const cleanedUpRef = useRef(false);
  const accessTokenRef = useRef<string | null>(null);

  const localStreamRef = useRef<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const iceConfigRef = useRef<RTCIceServer[]>([
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ]);
  const signalChannelRef = useRef<ReturnType<ReturnType<typeof getSupabase>['channel']> | null>(null);

  // Speaking detection refs
  const meterCtxRef = useRef<AudioContext | null>(null);
  const meterTimerRef = useRef<number | null>(null);
  const localSpeakingRef = useRef(false);
  const speakingTimersRef = useRef<Map<string, number>>(new Map());
  const remoteAnalysersRef = useRef<Map<string, { analyser: AnalyserNode; source: MediaStreamAudioSourceNode }>>(
    new Map()
  );

  // Built-in WebSocket Media Relay refs
  const relayWsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const videoTimerRef = useRef<number | null>(null);
  const peerNextPlayTimeRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  useEffect(() => {
    videoEnabledRef.current = videoEnabled;
  }, [videoEnabled]);

  useEffect(() => {
    transportModeRef.current = transportMode;
  }, [transportMode]);

  useEffect(() => {
    if (!onSpeakingUsersChange) return;
    const ids = Object.entries(speakingUsers)
      .filter(([, active]) => active)
      .map(([id]) => id);
    onSpeakingUsersChange(ids);
  }, [onSpeakingUsersChange, speakingUsers]);

  const markSpeakingPulse = useCallback((userId: string, holdMs = 340) => {
    setSpeakingUsers((prev) => (prev[userId] ? prev : { ...prev, [userId]: true }));
    const existingTimer = speakingTimersRef.current.get(userId);
    if (existingTimer) window.clearTimeout(existingTimer);
    const t = window.setTimeout(() => {
      speakingTimersRef.current.delete(userId);
      setSpeakingUsers((prev) => {
        if (!prev[userId]) return prev;
        const next = { ...prev };
        delete next[userId];
        return next;
      });
    }, holdMs);
    speakingTimersRef.current.set(userId, t);
  }, []);

  const setUserSpeakingState = useCallback((userId: string, active: boolean) => {
    const existingTimer = speakingTimersRef.current.get(userId);
    if (existingTimer) {
      window.clearTimeout(existingTimer);
      speakingTimersRef.current.delete(userId);
    }
    setSpeakingUsers((prev) => {
      if (Boolean(prev[userId]) === active) return prev;
      if (!active) {
        const next = { ...prev };
        delete next[userId];
        return next;
      }
      return { ...prev, [userId]: true };
    });
  }, []);

  const stopRelayStreaming = useCallback(() => {
    if (videoTimerRef.current) {
      window.clearInterval(videoTimerRef.current);
      videoTimerRef.current = null;
    }
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    if (relayWsRef.current) {
      relayWsRef.current.close();
      relayWsRef.current = null;
    }
    peerNextPlayTimeRef.current.clear();
    setRelayFrames({});
  }, []);

  const startRelayStreaming = useCallback(async () => {
    if (relayWsRef.current && relayWsRef.current.readyState === WebSocket.OPEN) return;

    const supabase = getSupabase();
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) return;

    const sbCfg = getActiveSupabaseConfig();
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = new URL(`${proto}//${window.location.host}/ws/voice`);
    wsUrl.searchParams.set('channelId', channel.id);
    wsUrl.searchParams.set('token', token);
    if (sbCfg) {
      wsUrl.searchParams.set('sbUrl', sbCfg.supabaseUrl);
      wsUrl.searchParams.set('sbAnon', sbCfg.supabaseAnonKey);
    }

    const ws = new WebSocket(wsUrl.toString());
    ws.binaryType = 'arraybuffer';
    relayWsRef.current = ws;

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx({ sampleRate: 16000 });
    audioCtxRef.current = ctx;

    ws.onopen = () => {
      if (localStreamRef.current && localStreamRef.current.getAudioTracks().length > 0) {
        try {
          const source = ctx.createMediaStreamSource(localStreamRef.current);
          const proc = ctx.createScriptProcessor(2048, 1, 1);
          const zeroGain = ctx.createGain();
          zeroGain.gain.value = 0;
          processorRef.current = proc;

          proc.onaudioprocess = (ev) => {
            if (mutedRef.current || ws.readyState !== WebSocket.OPEN) return;
            const input = ev.inputBuffer.getChannelData(0);
            const pcm = new Int16Array(input.length);
            for (let i = 0; i < input.length; i++) {
              const s = Math.max(-1, Math.min(1, input[i]));
              pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
            }
            ws.send(pcm.buffer);
          };

          source.connect(proc);
          proc.connect(zeroGain);
          zeroGain.connect(ctx.destination);
        } catch {
          // ignore audio capture setup failure
        }
      }

      const offscreen = document.createElement('canvas');
      offscreen.width = 480;
      offscreen.height = 270;
      const offCtx = offscreen.getContext('2d');

      videoTimerRef.current = window.setInterval(() => {
        if (
          !videoEnabledRef.current ||
          !localVideoRef.current ||
          !offCtx ||
          ws.readyState !== WebSocket.OPEN
        ) {
          return;
        }
        if (localVideoRef.current.readyState >= 2) {
          offCtx.drawImage(localVideoRef.current, 0, 0, offscreen.width, offscreen.height);
          const frame = offscreen.toDataURL('image/jpeg', 0.62);
          ws.send(JSON.stringify({ type: 'video-frame', frame }));
        }
      }, 100);
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data) as { type?: string; senderId?: string; frame?: string };
          if (msg.type === 'video-frame' && msg.senderId && msg.frame) {
            setRelayFrames((prev) => ({ ...prev, [msg.senderId!]: msg.frame! }));
          } else if (msg.type === 'video-off' && msg.senderId) {
            setRelayFrames((prev) => {
              if (!prev[msg.senderId!]) return prev;
              const next = { ...prev };
              delete next[msg.senderId!];
              return next;
            });
          }
        } catch {
          // ignore
        }
      } else if (ev.data instanceof ArrayBuffer && ev.data.byteLength > 36) {
        const header = new Uint8Array(ev.data, 0, 36);
        const senderId = new TextDecoder().decode(header);
        const pcm = new Int16Array(ev.data, 36);
        if (pcm.length === 0) return;

        let sumSq = 0;
        for (let i = 0; i < pcm.length; i++) {
          const norm = pcm[i] / 32768;
          sumSq += norm * norm;
        }
        const rms = Math.sqrt(sumSq / pcm.length);
        if (rms > 0.015) {
          markSpeakingPulse(senderId, 340);
        }

        if (ctx.state === 'suspended') {
          ctx.resume().catch(() => {});
        }
        const floatBuf = ctx.createBuffer(1, pcm.length, 16000);
        const out = floatBuf.getChannelData(0);
        for (let i = 0; i < pcm.length; i++) {
          out[i] = pcm[i] / 32768;
        }

        const src = ctx.createBufferSource();
        src.buffer = floatBuf;
        src.connect(ctx.destination);

        const now = ctx.currentTime;
        const scheduled = peerNextPlayTimeRef.current.get(senderId) || now;
        const playAt = Math.max(now + 0.02, scheduled);
        src.start(playAt);
        peerNextPlayTimeRef.current.set(senderId, playAt + floatBuf.duration);
      }
    };
  }, [channel.id, markSpeakingPulse]);

  const setupAudioLevelMonitoring = useCallback(
    (localStream: MediaStream | null) => {
      if (meterTimerRef.current) {
        window.clearInterval(meterTimerRef.current);
        meterTimerRef.current = null;
      }
      if (meterCtxRef.current) {
        meterCtxRef.current.close().catch(() => {});
        meterCtxRef.current = null;
      }
      remoteAnalysersRef.current.clear();

      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;

      const ctx = new AudioCtx();
      meterCtxRef.current = ctx;

      let localAnalyser: AnalyserNode | null = null;
      if (localStream && localStream.getAudioTracks().length > 0) {
        try {
          const src = ctx.createMediaStreamSource(localStream);
          localAnalyser = ctx.createAnalyser();
          localAnalyser.fftSize = 256;
          src.connect(localAnalyser);
        } catch {
          localAnalyser = null;
        }
      }

      const buf = new Uint8Array(256);
      let silenceTicks = 0;

      meterTimerRef.current = window.setInterval(() => {
        if (ctx.state === 'suspended') {
          ctx.resume().catch(() => {});
        }

        if (localAnalyser) {
          if (mutedRef.current) {
            if (localSpeakingRef.current) {
              localSpeakingRef.current = false;
              setUserSpeakingState(currentUser.id, false);
              signalChannelRef.current?.send({
                type: 'broadcast',
                event: 'rtc-speaking',
                payload: { from: currentUser.id, speaking: false },
              });
            }
          } else {
            localAnalyser.getByteTimeDomainData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i++) {
              const v = (buf[i] - 128) / 128;
              sum += v * v;
            }
            const rms = Math.sqrt(sum / buf.length);
            const activeNow = rms > 0.018;

            if (activeNow) {
              silenceTicks = 0;
              if (!localSpeakingRef.current) {
                localSpeakingRef.current = true;
                setUserSpeakingState(currentUser.id, true);
                signalChannelRef.current?.send({
                  type: 'broadcast',
                  event: 'rtc-speaking',
                  payload: { from: currentUser.id, speaking: true },
                });
              }
            } else if (localSpeakingRef.current) {
              silenceTicks += 1;
              if (silenceTicks >= 4) {
                localSpeakingRef.current = false;
                setUserSpeakingState(currentUser.id, false);
                signalChannelRef.current?.send({
                  type: 'broadcast',
                  event: 'rtc-speaking',
                  payload: { from: currentUser.id, speaking: false },
                });
              }
            }
          }
        }

        // Also sample remote WebRTC audio tracks locally
        for (const [peerId, entry] of remoteAnalysersRef.current.entries()) {
          entry.analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / buf.length);
          if (rms > 0.018) {
            markSpeakingPulse(peerId, 340);
          }
        }
      }, 80);
    },
    [currentUser.id, markSpeakingPulse, setUserSpeakingState]
  );

  // Attach WebRTC remote audio streams to analysers whenever remoteStreams updates
  useEffect(() => {
    const ctx = meterCtxRef.current;
    if (!ctx) return;

    const currentIds = new Set(remoteStreams.map((r) => r.userId));
    for (const [peerId, entry] of remoteAnalysersRef.current.entries()) {
      if (!currentIds.has(peerId)) {
        try {
          entry.source.disconnect();
        } catch {
          // ignore
        }
        remoteAnalysersRef.current.delete(peerId);
      }
    }

    for (const r of remoteStreams) {
      if (remoteAnalysersRef.current.has(r.userId)) continue;
      if (r.stream.getAudioTracks().length === 0) continue;
      try {
        const audioOnly = new MediaStream(r.stream.getAudioTracks());
        const source = ctx.createMediaStreamSource(audioOnly);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        remoteAnalysersRef.current.set(r.userId, { analyser, source });
      } catch {
        // ignore
      }
    }
  }, [remoteStreams]);

  const notifyServerPresenceChanged = useCallback(() => {
    try {
      const ch = getSupabase().channel(`server-meta:${channel.server_id}`);
      ch.send({
        type: 'broadcast',
        event: 'voice-sync',
        payload: { userId: currentUser.id, channelId: channel.id },
      }).catch(() => {});
    } catch {
      // ignore
    }
  }, [channel.id, channel.server_id, currentUser.id]);

  const sendKeepaliveLeave = useCallback(() => {
    const sbCfg = getActiveSupabaseConfig();
    const token = accessTokenRef.current;
    if (!sbCfg || !token) return;
    try {
      fetch(
        `${sbCfg.supabaseUrl}/rest/v1/voice_channel_participants?user_id=eq.${encodeURIComponent(currentUser.id)}`,
        {
          method: 'DELETE',
          keepalive: true,
          headers: {
            apikey: sbCfg.supabaseAnonKey,
            Authorization: `Bearer ${token}`,
          },
        }
      ).catch(() => {});
    } catch {
      // ignore
    }
  }, [currentUser.id]);

  const cleanupConnections = useCallback(async () => {
    if (cleanedUpRef.current) return;
    cleanedUpRef.current = true;

    stopRelayStreaming();

    if (meterTimerRef.current) {
      window.clearInterval(meterTimerRef.current);
      meterTimerRef.current = null;
    }
    if (meterCtxRef.current) {
      meterCtxRef.current.close().catch(() => {});
      meterCtxRef.current = null;
    }
    remoteAnalysersRef.current.clear();

    for (const timer of speakingTimersRef.current.values()) {
      window.clearTimeout(timer);
    }
    speakingTimersRef.current.clear();
    setSpeakingUsers({});
    onSpeakingUsersChange?.([]);

    for (const pc of peersRef.current.values()) {
      pc.close();
    }
    peersRef.current.clear();
    setRemoteStreams([]);

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }

    if (signalChannelRef.current) {
      await signalChannelRef.current
        .send({
          type: 'broadcast',
          event: 'rtc-leave',
          payload: { from: currentUser.id },
        })
        .catch(() => {});
      getSupabase().removeChannel(signalChannelRef.current);
      signalChannelRef.current = null;
    }

    await getSupabase()
      .from('voice_channel_participants')
      .delete()
      .eq('user_id', currentUser.id);

    notifyServerPresenceChanged();
  }, [currentUser.id, notifyServerPresenceChanged, onSpeakingUsersChange, stopRelayStreaming]);

  const createPeer = useCallback(
    (peerId: string, initiator: boolean) => {
      const existing = peersRef.current.get(peerId);
      if (existing) existing.close();

      const pc = new RTCPeerConnection({ iceServers: iceConfigRef.current });
      peersRef.current.set(peerId, pc);

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => {
          pc.addTrack(track, localStreamRef.current!);
        });
      }

      const fallbackTimer = window.setTimeout(() => {
        if (
          pc.iceConnectionState !== 'connected' &&
          pc.iceConnectionState !== 'completed' &&
          transportModeRef.current === 'p2p'
        ) {
          setTransportMode('relay');
          startRelayStreaming();
          signalChannelRef.current?.send({
            type: 'broadcast',
            event: 'rtc-mode',
            payload: { from: currentUser.id, mode: 'relay' },
          });
        }
      }, 6500);

      pc.onicecandidate = (ev) => {
        if (ev.candidate && signalChannelRef.current) {
          signalChannelRef.current.send({
            type: 'broadcast',
            event: 'rtc-ice',
            payload: { from: currentUser.id, to: peerId, candidate: ev.candidate },
          });
        }
      };

      pc.ontrack = (ev) => {
        const [stream] = ev.streams;
        if (!stream) return;
        setRemoteStreams((prev) => {
          const filtered = prev.filter((e) => e.userId !== peerId);
          return [...filtered, { userId: peerId, stream }];
        });
      };

      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          window.clearTimeout(fallbackTimer);
        } else if (pc.iceConnectionState === 'failed') {
          window.clearTimeout(fallbackTimer);
          setTransportMode('relay');
          startRelayStreaming();
          signalChannelRef.current?.send({
            type: 'broadcast',
            event: 'rtc-mode',
            payload: { from: currentUser.id, mode: 'relay' },
          });
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          setRemoteStreams((prev) => prev.filter((e) => e.userId !== peerId));
        }
      };

      if (initiator) {
        pc.createOffer()
          .then((offer) => pc.setLocalDescription(offer).then(() => offer))
          .then((offer) => {
            signalChannelRef.current?.send({
              type: 'broadcast',
              event: 'rtc-offer',
              payload: { from: currentUser.id, to: peerId, sdp: offer },
            });
          })
          .catch(() => {});
      }

      return pc;
    },
    [currentUser.id, startRelayStreaming]
  );

  useEffect(() => {
    let active = true;
    cleanedUpRef.current = false;

    async function joinRoom() {
      setConnectionError(null);
      try {
        const supabase = getSupabase();
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token || null;
        accessTokenRef.current = token;
        const sbCfg = getActiveSupabaseConfig();

        if (token) {
          const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
          if (sbCfg) {
            headers['x-supabase-url'] = sbCfg.supabaseUrl;
            headers['x-supabase-anon-key'] = sbCfg.supabaseAnonKey;
          }
          const iceRes = await fetch('/api/ice-servers', { headers });
          if (iceRes.ok) {
            const iceJson = (await iceRes.json()) as { iceServers: RTCIceServer[] };
            iceConfigRef.current = iceJson.iceServers;
          }
        }

        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          if (!active) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          localStreamRef.current = stream;
        } catch (mediaErr) {
          const msg =
            mediaErr instanceof DOMException && mediaErr.name === 'NotAllowedError'
              ? 'Microphone permission was denied. Allow microphone access in your browser settings to transmit audio.'
              : 'Could not access microphone device. You can still listen or enable camera/screen share.';
          if (active) setConnectionError(msg);
        }

        if (!active) return;

        setupAudioLevelMonitoring(localStreamRef.current);

        // Remove any stale voice presence for this user across channels before joining
        await supabase.from('voice_channel_participants').delete().eq('user_id', currentUser.id);

        if (!active) return;

        await supabase.from('voice_channel_participants').upsert(
          {
            channel_id: channel.id,
            user_id: currentUser.id,
            server_id: channel.server_id,
            muted: false,
            video_enabled: false,
          },
          { onConflict: 'channel_id,user_id' }
        );
        notifyServerPresenceChanged();

        const rtcChannel = supabase.channel(`dompic-rtc:${channel.id}`);
        signalChannelRef.current = rtcChannel;

        rtcChannel
          .on('broadcast', { event: 'rtc-join' }, ({ payload }) => {
            if (!payload?.from || payload.from === currentUser.id) return;
            createPeer(payload.from as string, true);
          })
          .on('broadcast', { event: 'rtc-offer' }, async ({ payload }) => {
            if (payload?.to !== currentUser.id || !payload?.from) return;
            const pc = createPeer(payload.from as string, false);
            await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            rtcChannel.send({
              type: 'broadcast',
              event: 'rtc-answer',
              payload: { from: currentUser.id, to: payload.from, sdp: answer },
            });
          })
          .on('broadcast', { event: 'rtc-answer' }, async ({ payload }) => {
            if (payload?.to !== currentUser.id || !payload?.from) return;
            const pc = peersRef.current.get(payload.from as string);
            if (pc && pc.signalingState !== 'stable') {
              await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
            }
          })
          .on('broadcast', { event: 'rtc-ice' }, async ({ payload }) => {
            if (payload?.to !== currentUser.id || !payload?.from || !payload?.candidate) return;
            const pc = peersRef.current.get(payload.from as string);
            if (pc) {
              await pc.addIceCandidate(new RTCIceCandidate(payload.candidate)).catch(() => {});
            }
          })
          .on('broadcast', { event: 'rtc-speaking' }, ({ payload }) => {
            if (!payload?.from || payload.from === currentUser.id) return;
            setUserSpeakingState(payload.from as string, Boolean(payload.speaking));
          })
          .on('broadcast', { event: 'rtc-mode' }, ({ payload }) => {
            if (!payload?.from || payload.from === currentUser.id) return;
            if (payload.mode === 'relay' && transportModeRef.current !== 'relay') {
              setTransportMode('relay');
              startRelayStreaming();
            }
          })
          .on('broadcast', { event: 'rtc-leave' }, ({ payload }) => {
            if (!payload?.from) return;
            const leaverId = payload.from as string;
            const pc = peersRef.current.get(leaverId);
            if (pc) {
              pc.close();
              peersRef.current.delete(leaverId);
            }
            setRemoteStreams((prev) => prev.filter((e) => e.userId !== leaverId));
            setUserSpeakingState(leaverId, false);
            setRelayFrames((prev) => {
              const next = { ...prev };
              delete next[leaverId];
              return next;
            });
          })
          .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
              rtcChannel.send({
                type: 'broadcast',
                event: 'rtc-join',
                payload: { from: currentUser.id },
              });
              if (transportModeRef.current === 'relay') {
                rtcChannel.send({
                  type: 'broadcast',
                  event: 'rtc-mode',
                  payload: { from: currentUser.id, mode: 'relay' },
                });
              }
            }
          });
      } catch (err) {
        if (active) {
          setConnectionError(err instanceof Error ? err.message : 'Failed to connect to voice room.');
        }
      }
    }

    joinRoom();

    const handleUnload = () => {
      sendKeepaliveLeave();
    };
    window.addEventListener('beforeunload', handleUnload);
    window.addEventListener('pagehide', handleUnload);

    return () => {
      active = false;
      window.removeEventListener('beforeunload', handleUnload);
      window.removeEventListener('pagehide', handleUnload);
      cleanupConnections();
    };
  }, [
    channel.id,
    channel.server_id,
    cleanupConnections,
    createPeer,
    currentUser.id,
    notifyServerPresenceChanged,
    sendKeepaliveLeave,
    setUserSpeakingState,
    setupAudioLevelMonitoring,
    startRelayStreaming,
  ]);

  const toggleTransportMode = () => {
    if (transportMode === 'p2p') {
      setTransportMode('relay');
      startRelayStreaming();
      signalChannelRef.current?.send({
        type: 'broadcast',
        event: 'rtc-mode',
        payload: { from: currentUser.id, mode: 'relay' },
      });
    } else {
      setTransportMode('p2p');
      stopRelayStreaming();
    }
  };

  const toggleMute = async () => {
    const nextMuted = !muted;
    setMuted(nextMuted);
    localStreamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = !nextMuted;
    });
    if (nextMuted) {
      localSpeakingRef.current = false;
      setUserSpeakingState(currentUser.id, false);
      signalChannelRef.current?.send({
        type: 'broadcast',
        event: 'rtc-speaking',
        payload: { from: currentUser.id, speaking: false },
      });
    }
    await getSupabase()
      .from('voice_channel_participants')
      .update({ muted: nextMuted })
      .eq('channel_id', channel.id)
      .eq('user_id', currentUser.id);
  };

  const replaceVideoTrackForPeers = async (newTrack: MediaStreamTrack | null) => {
    for (const [peerId, pc] of peersRef.current.entries()) {
      const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
      if (sender) {
        await sender.replaceTrack(newTrack);
      } else if (newTrack && localStreamRef.current) {
        pc.addTrack(newTrack, localStreamRef.current);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        signalChannelRef.current?.send({
          type: 'broadcast',
          event: 'rtc-offer',
          payload: { from: currentUser.id, to: peerId, sdp: offer },
        });
      }
    }
  };

  const toggleVideo = async () => {
    setConnectionError(null);
    if (videoEnabled) {
      localStreamRef.current?.getVideoTracks().forEach((t) => {
        t.stop();
        localStreamRef.current?.removeTrack(t);
      });
      await replaceVideoTrackForPeers(null);
      if (relayWsRef.current && relayWsRef.current.readyState === WebSocket.OPEN) {
        relayWsRef.current.send(JSON.stringify({ type: 'video-off' }));
      }
      setVideoEnabled(false);
      setScreenSharing(false);
      await getSupabase()
        .from('voice_channel_participants')
        .update({ video_enabled: false })
        .eq('channel_id', channel.id)
        .eq('user_id', currentUser.id);
    } else {
      try {
        const camStream = await navigator.mediaDevices.getUserMedia({ video: true });
        const videoTrack = camStream.getVideoTracks()[0];
        if (!localStreamRef.current) {
          localStreamRef.current = new MediaStream([videoTrack]);
        } else {
          localStreamRef.current.addTrack(videoTrack);
        }
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = localStreamRef.current;
        }
        await replaceVideoTrackForPeers(videoTrack);
        setVideoEnabled(true);
        await getSupabase()
          .from('voice_channel_participants')
          .update({ video_enabled: true })
          .eq('channel_id', channel.id)
          .eq('user_id', currentUser.id);
      } catch {
        setConnectionError('Camera permission denied or no camera device detected.');
      }
    }
  };

  const toggleScreenShare = async () => {
    setConnectionError(null);
    if (screenSharing) {
      localStreamRef.current?.getVideoTracks().forEach((t) => {
        t.stop();
        localStreamRef.current?.removeTrack(t);
      });
      await replaceVideoTrackForPeers(null);
      if (relayWsRef.current && relayWsRef.current.readyState === WebSocket.OPEN) {
        relayWsRef.current.send(JSON.stringify({ type: 'video-off' }));
      }
      setScreenSharing(false);
      setVideoEnabled(false);
      return;
    }
    try {
      const disp = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = disp.getVideoTracks()[0];
      track.onended = () => {
        setScreenSharing(false);
        setVideoEnabled(false);
        replaceVideoTrackForPeers(null);
        if (relayWsRef.current && relayWsRef.current.readyState === WebSocket.OPEN) {
          relayWsRef.current.send(JSON.stringify({ type: 'video-off' }));
        }
      };
      if (!localStreamRef.current) {
        localStreamRef.current = new MediaStream([track]);
      } else {
        localStreamRef.current.getVideoTracks().forEach((t) => {
          t.stop();
          localStreamRef.current?.removeTrack(t);
        });
        localStreamRef.current.addTrack(track);
      }
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = localStreamRef.current;
      }
      await replaceVideoTrackForPeers(track);
      setScreenSharing(true);
      setVideoEnabled(true);
    } catch {
      setConnectionError('Screen sharing was cancelled or is unsupported on this browser.');
    }
  };

  const otherParticipants = participants.filter((p) => p.user_id !== currentUser.id);
  const localIsSpeaking = Boolean(speakingUsers[currentUser.id]) && !muted;

  return (
    <div className={hidden ? 'hidden' : 'flex-1 flex flex-col bg-[#0B0D11] min-h-0'}>
      <header className="h-14 px-5 border-b border-white/8 flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <Volume2 className="w-4 h-4 text-[#22C55E] shrink-0" />
          <span className="font-display text-sm font-bold text-white truncate">{channel.name}</span>
          <span className="text-xs text-[#9CA3AF] whitespace-nowrap">
            · <span className="font-mono tabular-nums">{participants.length}</span> connected
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={toggleTransportMode}
            title="Switch between direct WebRTC and built-in server media relay"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#12151C] border border-white/10 hover:border-white/25 text-xs font-medium text-[#D1D5DB] whitespace-nowrap"
          >
            <Radio className={`w-3.5 h-3.5 ${transportMode === 'relay' ? 'text-[#5B7CFA]' : 'text-[#22C55E]'}`} />
            <span>{transportMode === 'relay' ? 'Server Relay Active' : 'Direct WebRTC'}</span>
          </button>

          <button
            type="button"
            onClick={async () => {
              await cleanupConnections();
              onLeave();
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#EF4444] hover:bg-[#DC2626] text-xs font-semibold text-white whitespace-nowrap"
          >
            <PhoneOff className="w-3.5 h-3.5" />
            <span>Leave Channel</span>
          </button>
        </div>
      </header>

      <div className="p-5 flex-1 overflow-y-auto space-y-4">
        {connectionError && (
          <div className="rounded-xl bg-[#EF4444]/10 border border-[#EF4444]/30 px-4 py-3 text-xs text-[#FCA5A5] flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{connectionError}</span>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* Local Tile */}
          <div
            className={`relative bg-[#12151C] rounded-2xl overflow-hidden aspect-video flex flex-col items-center justify-center transition-all duration-150 ${
              localIsSpeaking
                ? 'border-2 border-[#5B7CFA] ring-2 ring-[#5B7CFA]/55 shadow-[0_0_24px_rgba(91,124,250,0.4)]'
                : 'border border-white/10'
            }`}
          >
            <video
              ref={localVideoRef}
              autoPlay
              muted
              playsInline
              className={`w-full h-full object-cover ${videoEnabled ? 'block' : 'hidden'}`}
            />
            {!videoEnabled && (
              <div className="flex flex-col items-center gap-2">
                <div
                  className={`rounded-full transition-all duration-150 ${
                    localIsSpeaking ? 'ring-3 ring-[#5B7CFA] ring-offset-2 ring-offset-[#12151C]' : ''
                  }`}
                >
                  <Avatar src={currentUser.avatar_url} name={currentUser.display_name} size="lg" />
                </div>
                <span className="text-xs font-medium text-white">You</span>
              </div>
            )}
            <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between px-2.5 py-1 rounded-lg bg-black/65 backdrop-blur-sm text-xs text-white">
              <span className="truncate font-medium flex items-center gap-1.5">
                {localIsSpeaking && <span className="w-2 h-2 rounded-full bg-[#5B7CFA] shrink-0 animate-pulse" />}
                {currentUser.display_name} (You)
              </span>
              {muted && <MicOff className="w-3.5 h-3.5 text-[#EF4444]" />}
            </div>
          </div>

          {/* Remote Participant Tiles */}
          {otherParticipants.map((p) => {
            const match = remoteStreams.find((r) => r.userId === p.user_id);
            return (
              <RemoteVideoTile
                key={p.user_id}
                participant={p}
                stream={match?.stream}
                relayFrame={relayFrames[p.user_id]}
                speaking={Boolean(speakingUsers[p.user_id])}
              />
            );
          })}
        </div>
      </div>

      {/* Controls Dock */}
      <div className="p-4 border-t border-white/8 bg-[#12151C] flex items-center justify-center gap-3 shrink-0">
        <button
          type="button"
          onClick={toggleMute}
          className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold transition-colors ${
            muted
              ? 'bg-[#EF4444]/20 border border-[#EF4444]/40 text-[#FCA5A5]'
              : 'bg-[#181C25] border border-white/10 hover:border-white/25 text-white'
          }`}
        >
          {muted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
          <span>{muted ? 'Unmute' : 'Mute'}</span>
        </button>

        <button
          type="button"
          onClick={toggleVideo}
          className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold transition-colors ${
            videoEnabled && !screenSharing
              ? 'bg-[#5B7CFA] text-white'
              : 'bg-[#181C25] border border-white/10 hover:border-white/25 text-white'
          }`}
        >
          {videoEnabled ? <Video className="w-4 h-4" /> : <VideoOff className="w-4 h-4" />}
          <span>{videoEnabled ? 'Camera Off' : 'Camera On'}</span>
        </button>

        <button
          type="button"
          onClick={toggleScreenShare}
          className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold transition-colors ${
            screenSharing
              ? 'bg-[#22C55E] text-white'
              : 'bg-[#181C25] border border-white/10 hover:border-white/25 text-white'
          }`}
        >
          <MonitorUp className="w-4 h-4" />
          <span>{screenSharing ? 'Stop Share' : 'Share Screen'}</span>
        </button>
      </div>
    </div>
  );
}
