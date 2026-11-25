import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Hash,
  Loader2,
  LogOut,
  Paperclip,
  Pencil,
  Plus,
  Send,
  Settings,
  Smile,
  Trash2,
  UserPlus,
  Users,
  Volume2,
  X,
} from 'lucide-react';
import {
  AttachmentRecord,
  ChannelMessage,
  GlobalEmoji,
  MessageReaction,
  Profile,
  Server,
  ServerChannel,
  ServerInvitation,
  ServerMember,
  ServerMemberRole,
  VoiceParticipant,
} from '../types';
import { getSupabase } from '../lib/supabase';
import {
  categorizeMime,
  formatRelativeTime,
  formatTimeClock,
  validateAttachmentFile,
} from '../lib/utils';
import { Avatar } from './Avatar';
import { CustomEmojiImg, EmojiPicker, RichTextWithEmojis } from './CustomEmoji';
import { AttachmentItem } from './AttachmentViewer';
import { VoiceRoomStage } from './VoiceRoomStage';

interface ServerWorkspaceViewProps {
  serverId: string;
  initialChannelId?: string;
  currentUser: Profile;
  globalEmojis: GlobalEmoji[];
  onOpenProfile: (userId: string) => void;
  onServerLeftOrDeleted: () => void;
  onServerUpdated: () => void;
}

const CHANNEL_PAGE_SIZE = 35;

export function ServerWorkspaceView({
  serverId,
  initialChannelId,
  currentUser,
  globalEmojis,
  onOpenProfile,
  onServerLeftOrDeleted,
  onServerUpdated,
}: ServerWorkspaceViewProps) {
  const [server, setServer] = useState<Server | null>(null);
  const [channels, setChannels] = useState<ServerChannel[]>([]);
  const [members, setMembers] = useState<ServerMember[]>([]);
  const [voiceParticipants, setVoiceParticipants] = useState<VoiceParticipant[]>([]);
  const [speakingVoiceUserIds, setSpeakingVoiceUserIds] = useState<string[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(initialChannelId || null);
  const [joinedVoiceChannelId, setJoinedVoiceChannelId] = useState<string | null>(null);

  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingServer, setLoadingServer] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);

  // Composer
  const [text, setText] = useState('');
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [reactingToMsgId, setReactingToMsgId] = useState<string | null>(null);
  const [typingUser, setTypingUser] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Modals
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [newChannelType, setNewChannelType] = useState<'text' | 'voice'>('text');
  const [editingChannel, setEditingChannel] = useState<ServerChannel | null>(null);
  const [renameChannelVal, setRenameChannelVal] = useState('');

  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteQuery, setInviteQuery] = useState('');
  const [inviteResults, setInviteResults] = useState<Profile[]>([]);
  const [pendingInvites, setPendingInvites] = useState<ServerInvitation[]>([]);
  const [inviteStatus, setInviteStatus] = useState<string | null>(null);

  const [showMembersModal, setShowMembersModal] = useState(false);
  const [showServerSettings, setShowServerSettings] = useState(false);
  const [editServerName, setEditServerName] = useState('');
  const [editServerDesc, setEditServerDesc] = useState('');

  const bottomRef = useRef<HTMLDivElement>(null);
  const typingTimerRef = useRef<number | null>(null);

  const myMembership = members.find((m) => m.user_id === currentUser.id);
  const canManageChannels = myMembership?.role === 'owner' || myMembership?.role === 'admin';
  const isOwner = server?.owner_id === currentUser.id;

  const loadServerData = useCallback(async () => {
    setLoadingServer(true);
    setError(null);
    try {
      const supabase = getSupabase();
      const [srvRes, chRes, memRes, vpRes] = await Promise.all([
        supabase.from('servers').select('*').eq('id', serverId).single(),
        supabase
          .from('server_channels')
          .select('*')
          .eq('server_id', serverId)
          .order('position', { ascending: true }),
        supabase
          .from('server_members')
          .select('*, profile:profiles(*)')
          .eq('server_id', serverId)
          .order('joined_at', { ascending: true }),
        supabase
          .from('voice_channel_participants')
          .select('*, profile:profiles(*)')
          .eq('server_id', serverId),
      ]);

      if (srvRes.error) throw srvRes.error;
      const srv = srvRes.data as Server;
      const chs = (chRes.data || []) as ServerChannel[];
      setServer(srv);
      setEditServerName(srv.name);
      setEditServerDesc(srv.description || '');
      setChannels(chs);
      setMembers((memRes.data || []) as unknown as ServerMember[]);
      setVoiceParticipants((vpRes.data || []) as unknown as VoiceParticipant[]);

      setActiveChannelId((cur) => {
        if (cur && chs.some((c) => c.id === cur)) return cur;
        const firstText = chs.find((c) => c.type === 'text') || chs[0];
        return firstText ? firstText.id : null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load server.');
    } finally {
      setLoadingServer(false);
    }
  }, [serverId]);

  const refreshVoiceParticipants = useCallback(async () => {
    const { data } = await getSupabase()
      .from('voice_channel_participants')
      .select('*, profile:profiles(*)')
      .eq('server_id', serverId);
    if (data) setVoiceParticipants((data || []) as unknown as VoiceParticipant[]);
  }, [serverId]);

  useEffect(() => {
    loadServerData();
  }, [loadServerData]);

  // Realtime listener for server channels & voice participants (unfiltered DELETE works without REPLICA IDENTITY FULL)
  useEffect(() => {
    const supabase = getSupabase();
    const ch = supabase
      .channel(`server-meta:${serverId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'server_channels', filter: `server_id=eq.${serverId}` },
        async () => {
          const { data } = await supabase
            .from('server_channels')
            .select('*')
            .eq('server_id', serverId)
            .order('position', { ascending: true });
          if (data) setChannels(data as ServerChannel[]);
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'voice_channel_participants' },
        () => {
          refreshVoiceParticipants();
        }
      )
      .on('broadcast', { event: 'voice-sync' }, () => {
        refreshVoiceParticipants();
      })
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [refreshVoiceParticipants, serverId]);

  const hydrateChannelMessages = useCallback(
    async (raw: ChannelMessage[]): Promise<ChannelMessage[]> => {
      if (raw.length === 0) return [];
      const supabase = getSupabase();
      const ids = raw.map((m) => m.id);
      const [attRes, reactRes] = await Promise.all([
        supabase.from('attachments').select('*').eq('context_type', 'channel').in('message_id', ids),
        supabase.from('message_reactions').select('*').eq('message_type', 'channel').in('message_id', ids),
      ]);

      const attMap = new Map<string, AttachmentRecord[]>();
      for (const a of (attRes.data || []) as AttachmentRecord[]) {
        if (!a.message_id) continue;
        const list = attMap.get(a.message_id) || [];
        list.push(a);
        attMap.set(a.message_id, list);
      }

      const reactMap = new Map<string, MessageReaction[]>();
      for (const r of (reactRes.data || []) as MessageReaction[]) {
        const list = reactMap.get(r.message_id) || [];
        list.push(r);
        reactMap.set(r.message_id, list);
      }

      return raw.map((m) => ({
        ...m,
        attachments: attMap.get(m.id) || [],
        reactions: reactMap.get(m.id) || [],
      }));
    },
    []
  );

  const activeChannel = channels.find((c) => c.id === activeChannelId) || null;

  const loadChannelMessages = useCallback(
    async (channelId: string, offset = 0, appendOlder = false) => {
      if (!appendOlder) setLoadingMsgs(true);
      try {
        const supabase = getSupabase();
        const { data } = await supabase
          .from('channel_messages')
          .select('*, author:profiles!channel_messages_author_id_fkey(*)')
          .eq('channel_id', channelId)
          .order('created_at', { ascending: false })
          .range(offset, offset + CHANNEL_PAGE_SIZE - 1);

        const ordered = ((data || []) as unknown as ChannelMessage[]).reverse();
        const hydrated = await hydrateChannelMessages(ordered);
        setHasMore((data || []).length === CHANNEL_PAGE_SIZE);
        setMessages((prev) => (appendOlder ? [...hydrated, ...prev] : hydrated));
        if (!appendOlder) {
          setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
        }
      } finally {
        setLoadingMsgs(false);
      }
    },
    [hydrateChannelMessages]
  );

  useEffect(() => {
    if (activeChannel?.type === 'text') {
      loadChannelMessages(activeChannel.id, 0, false);
    } else {
      setMessages([]);
    }
  }, [activeChannel?.id, activeChannel?.type, loadChannelMessages]);

  // Realtime listener for active text channel
  useEffect(() => {
    if (!activeChannel || activeChannel.type !== 'text') return;
    const supabase = getSupabase();
    const ch = supabase
      .channel(`text-ch:${activeChannel.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'channel_messages',
          filter: `channel_id=eq.${activeChannel.id}`,
        },
        async (payload) => {
          const inserted = payload.new as ChannelMessage;
          const { data: full } = await supabase
            .from('channel_messages')
            .select('*, author:profiles!channel_messages_author_id_fkey(*)')
            .eq('id', inserted.id)
            .single();
          if (full) {
            const [hydrated] = await hydrateChannelMessages([full as unknown as ChannelMessage]);
            setMessages((prev) => (prev.some((m) => m.id === hydrated.id) ? prev : [...prev, hydrated]));
            setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
          }
        }
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'channel_messages', filter: `channel_id=eq.${activeChannel.id}` },
        (payload) => {
          const oldId = (payload.old as { id?: string })?.id;
          if (oldId) setMessages((prev) => prev.filter((m) => m.id !== oldId));
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'message_reactions', filter: 'message_type=eq.channel' },
        () => {
          loadChannelMessages(activeChannel.id, 0, false);
        }
      )
      .on('broadcast', { event: 'typing' }, ({ payload }) => {
        if (payload?.userId && payload.userId !== currentUser.id) {
          setTypingUser(String(payload.displayName || 'Someone'));
          if (typingTimerRef.current) window.clearTimeout(typingTimerRef.current);
          typingTimerRef.current = window.setTimeout(() => setTypingUser(null), 2200);
        }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(ch);
    };
  }, [activeChannel, currentUser.id, hydrateChannelMessages, loadChannelMessages]);

  const sendChannelMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeChannel || activeChannel.type !== 'text' || (!text.trim() && !pendingFile)) return;
    setSending(true);
    setError(null);
    try {
      const supabase = getSupabase();
      const { data: msg, error: msgErr } = await supabase
        .from('channel_messages')
        .insert({
          channel_id: activeChannel.id,
          server_id: serverId,
          author_id: currentUser.id,
          content: text.trim(),
        })
        .select('*, author:profiles!channel_messages_author_id_fkey(*)')
        .single();
      if (msgErr) throw msgErr;

      let uploadedAttachments: AttachmentRecord[] = [];
      if (pendingFile) {
        const ext = pendingFile.name.split('.').pop() || 'bin';
        const storagePath = `${currentUser.id}/channel/${serverId}/${crypto.randomUUID()}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from('chat-attachments')
          .upload(storagePath, pendingFile, { contentType: pendingFile.type });
        if (upErr) throw upErr;

        const { data: attRow, error: attErr } = await supabase
          .from('attachments')
          .insert({
            uploader_id: currentUser.id,
            context_type: 'channel',
            context_id: serverId,
            message_id: msg.id,
            file_name: pendingFile.name,
            mime_type: pendingFile.type,
            file_size: pendingFile.size,
            category: categorizeMime(pendingFile.type),
            storage_bucket: 'chat-attachments',
            storage_path: storagePath,
          })
          .select('*')
          .single();
        if (attErr) throw attErr;
        uploadedAttachments = [attRow as AttachmentRecord];
      }

      const fullMsg: ChannelMessage = {
        ...(msg as unknown as ChannelMessage),
        attachments: uploadedAttachments,
        reactions: [],
      };
      setMessages((prev) => (prev.some((m) => m.id === fullMsg.id) ? prev : [...prev, fullMsg]));
      setText('');
      setPendingFile(null);
      setShowEmojiPicker(false);
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send channel message.');
    } finally {
      setSending(false);
    }
  };

  const toggleReaction = async (messageId: string, shortcode: string) => {
    const supabase = getSupabase();
    const target = messages.find((m) => m.id === messageId);
    const existing = target?.reactions?.find(
      (r) => r.user_id === currentUser.id && r.emoji_shortcode === shortcode
    );
    if (existing) {
      await supabase.from('message_reactions').delete().eq('id', existing.id);
    } else {
      await supabase.from('message_reactions').insert({
        message_type: 'channel',
        message_id: messageId,
        user_id: currentUser.id,
        emoji_shortcode: shortcode,
      });
    }
    setReactingToMsgId(null);
  };

  const deleteMessage = async (msgId: string) => {
    await getSupabase().from('channel_messages').delete().eq('id', msgId);
    setMessages((prev) => prev.filter((m) => m.id !== msgId));
  };

  // Channel CRUD (Owner / Admin)
  const handleCreateChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManageChannels || !newChannelName.trim()) return;
    const supabase = getSupabase();
    const cleanName =
      newChannelType === 'text'
        ? newChannelName.trim().toLowerCase().replace(/\s+/g, '-')
        : newChannelName.trim();
    const { data, error: chErr } = await supabase
      .from('server_channels')
      .insert({
        server_id: serverId,
        name: cleanName,
        type: newChannelType,
        position: channels.length,
      })
      .select('*')
      .single();
    if (chErr) {
      setError(chErr.message);
      return;
    }
    setChannels((prev) => [...prev, data as ServerChannel]);
    setNewChannelName('');
    setShowCreateChannel(false);
    setActiveChannelId((data as ServerChannel).id);
  };

  const handleRenameChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingChannel || !renameChannelVal.trim()) return;
    const clean =
      editingChannel.type === 'text'
        ? renameChannelVal.trim().toLowerCase().replace(/\s+/g, '-')
        : renameChannelVal.trim();
    const { data } = await getSupabase()
      .from('server_channels')
      .update({ name: clean })
      .eq('id', editingChannel.id)
      .select('*')
      .single();
    if (data) {
      setChannels((prev) => prev.map((c) => (c.id === editingChannel.id ? (data as ServerChannel) : c)));
    }
    setEditingChannel(null);
  };

  const moveChannel = async (channel: ServerChannel, dir: -1 | 1) => {
    const sameType = channels.filter((c) => c.type === channel.type);
    const idx = sameType.findIndex((c) => c.id === channel.id);
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= sameType.length) return;
    const other = sameType[swapIdx];

    const supabase = getSupabase();
    await Promise.all([
      supabase.from('server_channels').update({ position: other.position }).eq('id', channel.id),
      supabase.from('server_channels').update({ position: channel.position }).eq('id', other.id),
    ]);
    await loadServerData();
  };

  const deleteChannel = async (channelId: string) => {
    await getSupabase().from('server_channels').delete().eq('id', channelId);
    setChannels((prev) => prev.filter((c) => c.id !== channelId));
    if (activeChannelId === channelId) setActiveChannelId(null);
  };

  // Invite Search & Send
  const loadPendingInvites = useCallback(async () => {
    const { data } = await getSupabase()
      .from('server_invitations')
      .select('*, invitee:profiles!server_invitations_invitee_id_fkey(*)')
      .eq('server_id', serverId)
      .eq('status', 'pending');
    setPendingInvites((data || []) as unknown as ServerInvitation[]);
  }, [serverId]);

  useEffect(() => {
    if (!showInviteModal) return;
    loadPendingInvites();
  }, [loadPendingInvites, showInviteModal]);

  useEffect(() => {
    const clean = inviteQuery.trim().toLowerCase().replace(/^@/, '');
    if (!showInviteModal || !clean) {
      setInviteResults([]);
      return;
    }
    const t = setTimeout(async () => {
      const { data } = await getSupabase()
        .from('profiles')
        .select('*')
        .or(`username.ilike.%${clean}%,display_name.ilike.%${clean}%`)
        .limit(8);
      const memberIds = new Set(members.map((m) => m.user_id));
      setInviteResults(((data || []) as Profile[]).filter((u) => !memberIds.has(u.id)));
    }, 200);
    return () => clearTimeout(t);
  }, [inviteQuery, members, showInviteModal]);

  const sendInvite = async (target: Profile) => {
    setInviteStatus(null);
    const supabase = getSupabase();
    const { data: inv, error: invErr } = await supabase
      .from('server_invitations')
      .insert({
        server_id: serverId,
        inviter_id: currentUser.id,
        invitee_id: target.id,
      })
      .select('*')
      .single();
    if (invErr) {
      setInviteStatus(invErr.message);
      return;
    }
    await supabase.from('notifications').upsert(
      {
        recipient_id: target.id,
        actor_id: currentUser.id,
        type: 'server_invite',
        entity_id: inv.id,
        metadata: { server_name: server?.name || 'Server' },
        dedupe_key: `srv_invite_${inv.id}`,
      },
      { onConflict: 'recipient_id,dedupe_key', ignoreDuplicates: true }
    );
    setInviteStatus(`Invitation sent to @${target.username}`);
    loadPendingInvites();
  };

  const updateMemberRole = async (userId: string, role: ServerMemberRole) => {
    await getSupabase()
      .from('server_members')
      .update({ role })
      .eq('server_id', serverId)
      .eq('user_id', userId);
    setMembers((prev) => prev.map((m) => (m.user_id === userId ? { ...m, role } : m)));
  };

  const kickMember = async (userId: string) => {
    await getSupabase()
      .from('server_members')
      .delete()
      .eq('server_id', serverId)
      .eq('user_id', userId);
    setMembers((prev) => prev.filter((m) => m.user_id !== userId));
  };

  const leaveServer = async () => {
    if (isOwner) return;
    await getSupabase()
      .from('server_members')
      .delete()
      .eq('server_id', serverId)
      .eq('user_id', currentUser.id);
    onServerLeftOrDeleted();
  };

  const saveServerSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isOwner) return;
    const { data, error: updErr } = await getSupabase()
      .from('servers')
      .update({ name: editServerName.trim(), description: editServerDesc.trim() })
      .eq('id', serverId)
      .select('*')
      .single();
    if (!updErr && data) {
      setServer(data as Server);
      onServerUpdated();
      setShowServerSettings(false);
    }
  };

  const uploadServerIcon = async (file: File) => {
    if (!isOwner || !file.type.startsWith('image/')) return;
    const ext = file.name.split('.').pop() || 'png';
    const path = `${currentUser.id}/${serverId}_${Date.now()}.${ext}`;
    const supabase = getSupabase();
    const { error: upErr } = await supabase.storage
      .from('server-icons')
      .upload(path, file, { contentType: file.type, upsert: true });
    if (upErr) return;
    const { data: pub } = supabase.storage.from('server-icons').getPublicUrl(path);
    const { data } = await supabase
      .from('servers')
      .update({ icon_url: pub.publicUrl })
      .eq('id', serverId)
      .select('*')
      .single();
    if (data) {
      setServer(data as Server);
      onServerUpdated();
    }
  };

  if (loadingServer) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-[#5B7CFA]" />
      </div>
    );
  }

  if (!server) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-[#9CA3AF]">
        Server unavailable or access denied.
      </div>
    );
  }

  const textChannels = channels.filter((c) => c.type === 'text');
  const voiceChannels = channels.filter((c) => c.type === 'voice');
  const joinedVoiceChannel = channels.find((c) => c.id === joinedVoiceChannelId) || null;

  return (
    <div className="flex h-full min-h-0">
      {/* Channels Sidebar */}
      <aside className="w-64 border-r border-white/8 bg-[#0E1117] flex flex-col shrink-0">
        <div className="h-14 px-4 border-b border-white/8 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <Avatar src={server.icon_url} name={server.name} size="sm" />
            <span className="font-display text-sm font-bold text-white truncate">
              {server.name}
            </span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => setShowInviteModal(true)}
              title="Invite user by username"
              className="p-1.5 rounded-lg text-[#9CA3AF] hover:text-white hover:bg-white/5"
            >
              <UserPlus className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setShowMembersModal(true)}
              title="Members & roles"
              className="p-1.5 rounded-lg text-[#9CA3AF] hover:text-white hover:bg-white/5"
            >
              <Users className="w-4 h-4" />
            </button>
            {isOwner ? (
              <button
                type="button"
                onClick={() => setShowServerSettings(true)}
                title="Server settings"
                className="p-1.5 rounded-lg text-[#9CA3AF] hover:text-white hover:bg-white/5"
              >
                <Settings className="w-4 h-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={leaveServer}
                title="Leave server"
                className="p-1.5 rounded-lg text-[#9CA3AF] hover:text-[#EF4444] hover:bg-white/5"
              >
                <LogOut className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-5">
          {/* Text Channels */}
          <div>
            <div className="flex items-center justify-between px-2 mb-1.5">
              <span className="text-[11px] font-semibold tracking-wide text-[#9CA3AF]">
                Text Channels
              </span>
              {canManageChannels && (
                <button
                  type="button"
                  onClick={() => {
                    setNewChannelType('text');
                    setShowCreateChannel(true);
                  }}
                  title="Create channel"
                  className="p-1 rounded text-[#9CA3AF] hover:text-white hover:bg-white/5"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <div className="space-y-0.5">
              {textChannels.map((ch) => (
                <div
                  key={ch.id}
                  className={`group flex items-center justify-between rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
                    activeChannelId === ch.id && !joinedVoiceChannel
                      ? 'bg-[#181E2E] text-white font-semibold'
                      : 'text-[#9CA3AF] hover:text-white hover:bg-white/5'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setActiveChannelId(ch.id);
                    }}
                    className="flex items-center gap-2 min-w-0 flex-1 text-left"
                  >
                    <Hash className="w-3.5 h-3.5 shrink-0 opacity-75" />
                    <span className="truncate">{ch.name}</span>
                  </button>

                  {canManageChannels && (
                    <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => moveChannel(ch, -1)}
                        className="p-1 hover:text-white"
                        title="Move up"
                      >
                        <ArrowUp className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveChannel(ch, 1)}
                        className="p-1 hover:text-white"
                        title="Move down"
                      >
                        <ArrowDown className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingChannel(ch);
                          setRenameChannelVal(ch.name);
                        }}
                        className="p-1 hover:text-white"
                        title="Rename"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteChannel(ch.id)}
                        className="p-1 hover:text-[#EF4444]"
                        title="Delete"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Persistent Voice & Video Channels */}
          <div>
            <div className="flex items-center justify-between px-2 mb-1.5">
              <span className="text-[11px] font-semibold tracking-wide text-[#9CA3AF]">
                Voice &amp; Video
              </span>
              {canManageChannels && (
                <button
                  type="button"
                  onClick={() => {
                    setNewChannelType('voice');
                    setShowCreateChannel(true);
                  }}
                  title="Create voice channel"
                  className="p-1 rounded text-[#9CA3AF] hover:text-white hover:bg-white/5"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <div className="space-y-1">
              {voiceChannels.map((ch) => {
                const roomPeople = voiceParticipants.filter((p) => p.channel_id === ch.id);
                const isJoined = joinedVoiceChannelId === ch.id;
                return (
                  <div key={ch.id} className="space-y-1">
                    <div
                      className={`group flex items-center justify-between rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
                        isJoined
                          ? 'bg-[#22C55E]/15 text-[#86EFAC] font-semibold'
                          : 'text-[#9CA3AF] hover:text-white hover:bg-white/5'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setJoinedVoiceChannelId(ch.id);
                          setActiveChannelId(ch.id);
                        }}
                        className="flex items-center gap-2 min-w-0 flex-1 text-left"
                      >
                        <Volume2 className="w-3.5 h-3.5 shrink-0" />
                        <span className="truncate">{ch.name}</span>
                      </button>

                      {canManageChannels && (
                        <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => {
                              setEditingChannel(ch);
                              setRenameChannelVal(ch.name);
                            }}
                            className="p-1 hover:text-white"
                            title="Rename"
                          >
                            <Pencil className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteChannel(ch.id)}
                            className="p-1 hover:text-[#EF4444]"
                            title="Delete"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      )}
                    </div>

                    {roomPeople.length > 0 && (
                      <div className="pl-6 space-y-1">
                        {roomPeople.map((vp) => {
                          const isSpeaking = speakingVoiceUserIds.includes(vp.user_id) && !vp.muted;
                          return (
                            <div key={vp.user_id} className="flex items-center gap-2 text-[11px] text-[#D1D5DB]">
                              <div
                                className={`rounded-full transition-all duration-150 ${
                                  isSpeaking ? 'ring-2 ring-[#5B7CFA]' : ''
                                }`}
                              >
                                <Avatar
                                  src={vp.profile?.avatar_url}
                                  name={vp.profile?.display_name || 'M'}
                                  size="xs"
                                />
                              </div>
                              <span className={`truncate ${isSpeaking ? 'text-[#93C5FD] font-semibold' : ''}`}>
                                {vp.profile?.display_name || 'Member'}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </aside>

      {/* Main Channel Stage */}
      <section className="flex-1 flex flex-col min-w-0 bg-[#0B0D11]">
        {joinedVoiceChannel && (
          <VoiceRoomStage
            key={joinedVoiceChannel.id}
            channel={joinedVoiceChannel}
            currentUser={currentUser}
            participants={voiceParticipants.filter((p) => p.channel_id === joinedVoiceChannel.id)}
            hidden={activeChannel?.id !== joinedVoiceChannel.id}
            onSpeakingUsersChange={setSpeakingVoiceUserIds}
            onLeave={() => {
              setJoinedVoiceChannelId(null);
              setSpeakingVoiceUserIds([]);
              setVoiceParticipants((prev) => prev.filter((p) => p.user_id !== currentUser.id));
              refreshVoiceParticipants();
              const firstText = textChannels[0];
              if (firstText) setActiveChannelId(firstText.id);
            }}
          />
        )}

        {!(joinedVoiceChannel && activeChannel?.id === joinedVoiceChannel.id) &&
          (activeChannel?.type === 'voice' ? (
            <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
              <Volume2 className="w-10 h-10 text-[#22C55E] mb-3" />
              <h3 className="font-display text-lg font-bold text-white mb-1">
                {activeChannel.name}
              </h3>
              <p className="text-xs text-[#9CA3AF] mb-5 max-w-sm">
                Persistent voice &amp; video channel. Join anytime to talk or share video with server members.
              </p>
              <button
                type="button"
                onClick={() => {
                  // Play the join cue immediately, then enter the voice room one second later.
                  playSound('join_call');
                  window.setTimeout(() => setJoinedVoiceChannelId(activeChannel.id), 1000);
                }}
                className="px-5 py-2.5 rounded-xl bg-[#22C55E] hover:bg-[#16A34A] text-xs font-semibold text-white"
              >
                Join Voice &amp; Video
              </button>
            </div>
          ) : activeChannel ? (
          <>
            <header className="h-14 px-5 border-b border-white/8 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <Hash className="w-4 h-4 text-[#9CA3AF] shrink-0" />
                <span className="font-display text-sm font-bold text-white truncate">
                  {activeChannel.name}
                </span>
                {activeChannel.topic && (
                  <span className="hidden md:inline text-xs text-[#6B7280] truncate">
                    · {activeChannel.topic}
                  </span>
                )}
              </div>
              {joinedVoiceChannel && (
                <button
                  type="button"
                  onClick={() => setActiveChannelId(joinedVoiceChannel.id)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#22C55E]/15 border border-[#22C55E]/30 text-xs font-semibold text-[#86EFAC]"
                >
                  <Volume2 className="w-3.5 h-3.5" />
                  <span>Return to {joinedVoiceChannel.name}</span>
                </button>
              )}
            </header>

            {error && (
              <div className="mx-5 mt-3 rounded-lg bg-[#EF4444]/10 border border-[#EF4444]/30 px-3.5 py-2 text-xs text-[#FCA5A5] flex items-center justify-between">
                <span>{error}</span>
                <button type="button" onClick={() => setError(null)}>
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              {hasMore && (
                <div className="flex justify-center">
                  <button
                    type="button"
                    onClick={() => loadChannelMessages(activeChannel.id, messages.length, true)}
                    className="px-3.5 py-1.5 rounded-lg bg-[#12151C] border border-white/10 text-xs text-[#D1D5DB] hover:text-white"
                  >
                    Load older messages
                  </button>
                </div>
              )}

              {loadingMsgs ? (
                <div className="py-12 flex justify-center">
                  <Loader2 className="w-5 h-5 animate-spin text-[#5B7CFA]" />
                </div>
              ) : messages.length === 0 ? (
                <div className="py-16 text-center text-xs text-[#9CA3AF]">
                  Welcome to #{activeChannel.name}. Start the conversation below.
                </div>
              ) : (
                messages.map((msg) => {
                  const groupedReactions = (msg.reactions || []).reduce<
                    Record<string, { count: number; mine: boolean }>
                  >((acc, r) => {
                    const entry = acc[r.emoji_shortcode] || { count: 0, mine: false };
                    entry.count += 1;
                    if (r.user_id === currentUser.id) entry.mine = true;
                    acc[r.emoji_shortcode] = entry;
                    return acc;
                  }, {});

                  return (
                    <div key={msg.id} className="group flex gap-3 items-start relative">
                      <button
                        type="button"
                        onClick={() => msg.author && onOpenProfile(msg.author.id)}
                        className="shrink-0"
                      >
                        <Avatar
                          src={msg.author?.avatar_url}
                          name={msg.author?.display_name || 'U'}
                          size="sm"
                        />
                      </button>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 text-xs mb-0.5">
                          <button
                            type="button"
                            onClick={() => msg.author && onOpenProfile(msg.author.id)}
                            className="font-semibold text-white hover:underline"
                          >
                            {msg.author?.display_name || 'Member'}
                          </button>
                          <span className="text-[#9CA3AF]">@{msg.author?.username}</span>
                          <time className="font-mono text-[11px] text-[#6B7280]">
                            {formatTimeClock(msg.created_at)} · {formatRelativeTime(msg.created_at)}
                          </time>
                        </div>

                        {msg.content && (
                          <div className="text-sm text-[#E5E7EB]">
                            <RichTextWithEmojis text={msg.content} globalEmojis={globalEmojis} />
                          </div>
                        )}

                        {msg.attachments && msg.attachments.length > 0 && (
                          <div className="mt-2 space-y-2">
                            {msg.attachments.map((att) => (
                              <AttachmentItem key={att.id} attachment={att} />
                            ))}
                          </div>
                        )}

                        {Object.keys(groupedReactions).length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-1.5">
                            {Object.entries(groupedReactions).map(([code, info]) => (
                              <button
                                key={code}
                                type="button"
                                onClick={() => toggleReaction(msg.id, code)}
                                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-xs ${
                                  info.mine
                                    ? 'bg-[#5B7CFA]/20 border-[#5B7CFA]/50 text-white'
                                    : 'bg-[#12151C] border-white/10 text-[#D1D5DB]'
                                }`}
                              >
                                <CustomEmojiImg shortcode={code} globalEmojis={globalEmojis} size={15} />
                                <span className="font-mono tabular-nums text-[11px]">{info.count}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 transition-opacity">
                        <button
                          type="button"
                          onClick={() =>
                            setReactingToMsgId((cur) => (cur === msg.id ? null : msg.id))
                          }
                          className="p-1.5 rounded-lg text-[#9CA3AF] hover:text-white hover:bg-white/5"
                          title="React"
                        >
                          <Smile className="w-3.5 h-3.5" />
                        </button>
                        {(msg.author_id === currentUser.id || canManageChannels) && (
                          <button
                            type="button"
                            onClick={() => deleteMessage(msg.id)}
                            className="p-1.5 rounded-lg text-[#9CA3AF] hover:text-[#EF4444] hover:bg-white/5"
                            title="Delete message"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>

                      {reactingToMsgId === msg.id && (
                        <div className="absolute right-8 top-0 z-30">
                          <EmojiPicker
                            globalEmojis={globalEmojis}
                            onSelect={(code) => toggleReaction(msg.id, code)}
                            onClose={() => setReactingToMsgId(null)}
                          />
                        </div>
                      )}
                    </div>
                  );
                })
              )}
              <div ref={bottomRef} />
            </div>

            <div className="px-5 pb-4 pt-2 border-t border-white/8 relative">
              {typingUser && (
                <div className="text-[11px] text-[#9CA3AF] mb-1.5">{typingUser} is typing...</div>
              )}

              {pendingFile && (
                <div className="mb-2 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#12151C] border border-white/10 text-xs text-white">
                  <span className="truncate max-w-[200px]">{pendingFile.name}</span>
                  <span className="text-[#9CA3AF]">(expires in 24h)</span>
                  <button type="button" onClick={() => setPendingFile(null)}>
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {showEmojiPicker && (
                <div className="absolute bottom-16 left-5 z-30">
                  <EmojiPicker
                    globalEmojis={globalEmojis}
                    onSelect={(code) => setText((prev) => `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}:${code}: `)}
                    onClose={() => setShowEmojiPicker(false)}
                  />
                </div>
              )}

              <form
                onSubmit={sendChannelMessage}
                className="flex items-center gap-2 bg-[#12151C] border border-white/10 rounded-xl px-3 py-2"
              >
                <label className="p-1.5 rounded-lg text-[#9CA3AF] hover:text-white hover:bg-white/5 cursor-pointer" title="Attach file (24h expiration)">
                  <Paperclip className="w-4 h-4" />
                  <input
                    type="file"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      const err = validateAttachmentFile(f);
                      if (err) setError(err);
                      else setPendingFile(f);
                      e.target.value = '';
                    }}
                    className="hidden"
                  />
                </label>

                <button
                  type="button"
                  onClick={() => setShowEmojiPicker((v) => !v)}
                  className="p-1.5 rounded-lg text-[#9CA3AF] hover:text-white hover:bg-white/5"
                  title="Insert emoji"
                >
                  <Smile className="w-4 h-4" />
                </button>

                <input
                  type="text"
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                    getSupabase()
                      .channel(`text-ch:${activeChannel.id}`)
                      .send({
                        type: 'broadcast',
                        event: 'typing',
                        payload: { userId: currentUser.id, displayName: currentUser.display_name },
                      });
                  }}
                  placeholder={`Message #${activeChannel.name}...`}
                  maxLength={4000}
                  className="flex-1 bg-transparent text-sm text-white placeholder-[#6B7280] focus:outline-none"
                />

                <button
                  type="submit"
                  disabled={sending || (!text.trim() && !pendingFile)}
                  className="p-2 rounded-lg bg-[#5B7CFA] hover:bg-[#4B6CF0] disabled:opacity-40 text-white"
                >
                  <Send className="w-4 h-4" />
                </button>
              </form>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-xs text-[#9CA3AF]">
            Select a channel to start chatting.
          </div>
        ))}
      </section>

      {/* Create Channel Modal */}
      {showCreateChannel && (
        <div className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={handleCreateChannel}
            className="w-full max-w-sm bg-[#12151C] border border-white/10 rounded-2xl p-6 space-y-4"
          >
            <h3 className="font-display text-base font-bold text-white">Create Channel</h3>
            <div className="flex gap-2 p-1 bg-[#0B0D11] rounded-lg">
              {(['text', 'voice'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setNewChannelType(t)}
                  className={`flex-1 py-1.5 text-xs font-semibold rounded-md capitalize ${
                    newChannelType === t ? 'bg-[#5B7CFA] text-white' : 'text-[#9CA3AF]'
                  }`}
                >
                  {t === 'text' ? 'Text Channel' : 'Voice & Video'}
                </button>
              ))}
            </div>
            <input
              type="text"
              required
              maxLength={48}
              value={newChannelName}
              onChange={(e) => setNewChannelName(e.target.value)}
              placeholder={newChannelType === 'text' ? 'e.g. memes' : 'e.g. Hangout'}
              className="w-full rounded-lg bg-[#0B0D11] border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:border-[#5B7CFA]"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowCreateChannel(false)}
                className="px-3.5 py-2 text-xs text-[#9CA3AF]"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 rounded-lg bg-[#5B7CFA] text-xs font-semibold text-white"
              >
                Create
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Rename Channel Modal */}
      {editingChannel && (
        <div className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={handleRenameChannel}
            className="w-full max-w-sm bg-[#12151C] border border-white/10 rounded-2xl p-6 space-y-4"
          >
            <h3 className="font-display text-base font-bold text-white">Rename Channel</h3>
            <input
              type="text"
              required
              maxLength={48}
              value={renameChannelVal}
              onChange={(e) => setRenameChannelVal(e.target.value)}
              className="w-full rounded-lg bg-[#0B0D11] border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:border-[#5B7CFA]"
            />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setEditingChannel(null)} className="px-3.5 py-2 text-xs text-[#9CA3AF]">
                Cancel
              </button>
              <button type="submit" className="px-4 py-2 rounded-lg bg-[#5B7CFA] text-xs font-semibold text-white">
                Save
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Invite Users Modal */}
      {showInviteModal && (
        <div className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-[#12151C] border border-white/10 rounded-2xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-bold text-white">
                Invite to {server.name}
              </h3>
              <button type="button" onClick={() => setShowInviteModal(false)} className="text-[#9CA3AF] hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <input
              type="text"
              value={inviteQuery}
              onChange={(e) => setInviteQuery(e.target.value)}
              placeholder="Search username (e.g. @alex)..."
              className="w-full rounded-lg bg-[#0B0D11] border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:border-[#5B7CFA]"
            />

            {inviteStatus && <p className="text-xs text-[#86EFAC]">{inviteStatus}</p>}

            {inviteResults.length > 0 && (
              <div className="divide-y divide-white/8 border border-white/8 rounded-xl overflow-hidden max-h-44 overflow-y-auto">
                {inviteResults.map((u) => (
                  <div key={u.id} className="flex items-center justify-between p-2.5 bg-[#0B0D11]">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Avatar src={u.avatar_url} name={u.display_name} size="sm" />
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-white truncate">{u.display_name}</div>
                        <div className="text-[11px] text-[#9CA3AF]">@{u.username}</div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => sendInvite(u)}
                      className="px-3 py-1 rounded-lg bg-[#5B7CFA] text-xs font-semibold text-white"
                    >
                      Invite
                    </button>
                  </div>
                ))}
              </div>
            )}

            {pendingInvites.length > 0 && (
              <div className="pt-2 border-t border-white/8">
                <div className="text-xs font-semibold text-[#9CA3AF] mb-2">
                  Pending Invitations ({pendingInvites.length})
                </div>
                <div className="space-y-1.5 max-h-32 overflow-y-auto">
                  {pendingInvites.map((inv) => (
                    <div key={inv.id} className="flex items-center justify-between text-xs text-[#D1D5DB]">
                      <span>@{inv.invitee?.username}</span>
                      <span className="text-[#F59E0B]">Pending</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Members & Roles Modal */}
      {showMembersModal && (
        <div className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-[#12151C] border border-white/10 rounded-2xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-bold text-white">
                Members ({members.length})
              </h3>
              <button type="button" onClick={() => setShowMembersModal(false)} className="text-[#9CA3AF] hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="divide-y divide-white/8 max-h-80 overflow-y-auto">
              {members.map((m) => (
                <div key={m.user_id} className="py-2.5 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setShowMembersModal(false);
                      onOpenProfile(m.user_id);
                    }}
                    className="flex items-center gap-2.5 min-w-0 text-left"
                  >
                    <Avatar src={m.profile?.avatar_url} name={m.profile?.display_name || 'U'} size="sm" />
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-white truncate">{m.profile?.display_name}</div>
                      <div className="text-[11px] text-[#9CA3AF]">@{m.profile?.username}</div>
                    </div>
                  </button>

                  <div className="flex items-center gap-2 shrink-0">
                    {canManageChannels && m.role !== 'owner' && m.user_id !== currentUser.id ? (
                      <>
                        <select
                          value={m.role}
                          onChange={(e) => updateMemberRole(m.user_id, e.target.value as ServerMemberRole)}
                          className="rounded-md bg-[#0B0D11] border border-white/10 px-2 py-1 text-[11px] text-white"
                        >
                          <option value="admin">Admin</option>
                          <option value="moderator">Moderator</option>
                          <option value="member">Member</option>
                        </select>
                        <button
                          type="button"
                          onClick={() => kickMember(m.user_id)}
                          className="p-1 text-[#9CA3AF] hover:text-[#EF4444]"
                          title="Remove member"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </>
                    ) : (
                      <span className="text-[11px] font-mono capitalize text-[#9CA3AF]">{m.role}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Server Settings Modal */}
      {showServerSettings && isOwner && (
        <div className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={saveServerSettings}
            className="w-full max-w-md bg-[#12151C] border border-white/10 rounded-2xl p-6 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-bold text-white">Server Settings</h3>
              <button type="button" onClick={() => setShowServerSettings(false)} className="text-[#9CA3AF] hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex items-center gap-3">
              <Avatar src={server.icon_url} name={server.name} size="lg" />
              <label className="px-3.5 py-2 rounded-lg bg-[#0B0D11] border border-white/10 hover:border-white/25 text-xs font-medium text-white cursor-pointer">
                Upload Icon
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => e.target.files?.[0] && uploadServerIcon(e.target.files[0])}
                  className="hidden"
                />
              </label>
            </div>

            <div>
              <label className="block text-xs text-[#D1D5DB] mb-1">Server Name</label>
              <input
                type="text"
                required
                minLength={2}
                maxLength={60}
                value={editServerName}
                onChange={(e) => setEditServerName(e.target.value)}
                className="w-full rounded-lg bg-[#0B0D11] border border-white/10 px-3.5 py-2 text-sm text-white"
              />
            </div>

            <div>
              <label className="block text-xs text-[#D1D5DB] mb-1">Description</label>
              <textarea
                rows={2}
                value={editServerDesc}
                onChange={(e) => setEditServerDesc(e.target.value)}
                className="w-full rounded-lg bg-[#0B0D11] border border-white/10 px-3.5 py-2 text-sm text-white"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowServerSettings(false)} className="px-3.5 py-2 text-xs text-[#9CA3AF]">
                Cancel
              </button>
              <button type="submit" className="px-4 py-2 rounded-lg bg-[#5B7CFA] text-xs font-semibold text-white">
                Save Changes
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
