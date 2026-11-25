import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Loader2,
  Mail,
  Paperclip,
  Search,
  Send,
  Smile,
  X,
} from 'lucide-react';
import {
  AttachmentRecord,
  Conversation,
  DirectMessage,
  GlobalEmoji,
  MessageReaction,
  Profile,
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

interface MessagesViewProps {
  currentUser: Profile;
  globalEmojis: GlobalEmoji[];
  initialConversationId?: string;
  onOpenProfile: (userId: string) => void;
  onUnreadCountChange: (count: number) => void;
}

const DM_PAGE_SIZE = 30;

export function MessagesView({
  currentUser,
  globalEmojis,
  initialConversationId,
  onOpenProfile,
  onUnreadCountChange,
}: MessagesViewProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvoId, setActiveConvoId] = useState<string | null>(initialConversationId || null);
  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingConvos, setLoadingConvos] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);

  // Composer
  const [text, setText] = useState('');
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [reactingToMsgId, setReactingToMsgId] = useState<string | null>(null);
  const [typingPeer, setTypingPeer] = useState<string | null>(null);

  // New DM search
  const [searchUsername, setSearchUsername] = useState('');
  const [searchResults, setSearchResults] = useState<Profile[]>([]);
  const [error, setError] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const typingTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (initialConversationId) {
      setActiveConvoId(initialConversationId);
    }
  }, [initialConversationId]);

  const loadConversations = useCallback(async () => {
    setLoadingConvos(true);
    try {
      const supabase = getSupabase();
      const { data: convos } = await supabase
        .from('conversations')
        .select('*')
        .or(`user_a.eq.${currentUser.id},user_b.eq.${currentUser.id}`)
        .order('last_message_at', { ascending: false });

      const rows = (convos || []) as Conversation[];
      if (rows.length === 0) {
        setConversations([]);
        onUnreadCountChange(0);
        return;
      }

      const otherIds = rows.map((c) => (c.user_a === currentUser.id ? c.user_b : c.user_a));
      const convoIds = rows.map((c) => c.id);

      const [profilesRes, readsRes] = await Promise.all([
        supabase.from('profiles').select('*').in('id', otherIds),
        supabase
          .from('conversation_reads')
          .select('*')
          .eq('user_id', currentUser.id)
          .in('conversation_id', convoIds),
      ]);

      const profMap = new Map<string, Profile>();
      for (const p of (profilesRes.data || []) as Profile[]) {
        profMap.set(p.id, p);
      }
      const readMap = new Map<string, string>();
      for (const r of readsRes.data || []) {
        readMap.set(r.conversation_id as string, r.last_read_at as string);
      }

      let unreadTotal = 0;
      const hydrated = rows.map((c) => {
        const otherId = c.user_a === currentUser.id ? c.user_b : c.user_a;
        const lastRead = readMap.get(c.id);
        const unread =
          c.id !== activeConvoId &&
          (!lastRead || new Date(c.last_message_at).getTime() > new Date(lastRead).getTime());
        if (unread) unreadTotal += 1;
        return {
          ...c,
          other_user: profMap.get(otherId),
          unread,
        };
      });

      setConversations(hydrated);
      onUnreadCountChange(unreadTotal);
      if (!activeConvoId && hydrated.length > 0 && !initialConversationId) {
        setActiveConvoId(hydrated[0].id);
      }
    } finally {
      setLoadingConvos(false);
    }
  }, [activeConvoId, currentUser.id, initialConversationId, onUnreadCountChange]);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  const markConversationRead = useCallback(
    async (convoId: string) => {
      const supabase = getSupabase();
      await supabase.from('conversation_reads').upsert(
        {
          conversation_id: convoId,
          user_id: currentUser.id,
          last_read_at: new Date().toISOString(),
        },
        { onConflict: 'conversation_id,user_id' }
      );
      setConversations((prev) =>
        prev.map((c) => (c.id === convoId ? { ...c, unread: false } : c))
      );
    },
    [currentUser.id]
  );

  const hydrateMessages = useCallback(async (rawMsgs: DirectMessage[]): Promise<DirectMessage[]> => {
    if (rawMsgs.length === 0) return [];
    const supabase = getSupabase();
    const msgIds = rawMsgs.map((m) => m.id);
    const [attRes, reactRes] = await Promise.all([
      supabase
        .from('attachments')
        .select('*')
        .eq('context_type', 'dm')
        .in('message_id', msgIds),
      supabase
        .from('message_reactions')
        .select('*')
        .eq('message_type', 'dm')
        .in('message_id', msgIds),
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

    return rawMsgs.map((m) => ({
      ...m,
      attachments: attMap.get(m.id) || [],
      reactions: reactMap.get(m.id) || [],
    }));
  }, []);

  const loadMessages = useCallback(
    async (convoId: string, offset = 0, appendOlder = false) => {
      if (!appendOlder) setLoadingMsgs(true);
      try {
        const supabase = getSupabase();
        const { data } = await supabase
          .from('direct_messages')
          .select('*, sender:profiles!direct_messages_sender_id_fkey(*)')
          .eq('conversation_id', convoId)
          .order('created_at', { ascending: false })
          .range(offset, offset + DM_PAGE_SIZE - 1);

        const ordered = ((data || []) as unknown as DirectMessage[]).reverse();
        const hydrated = await hydrateMessages(ordered);
        setHasMore((data || []).length === DM_PAGE_SIZE);
        setMessages((prev) => (appendOlder ? [...hydrated, ...prev] : hydrated));
        if (!appendOlder) {
          markConversationRead(convoId);
          setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 60);
        }
      } finally {
        setLoadingMsgs(false);
      }
    },
    [hydrateMessages, markConversationRead]
  );

  useEffect(() => {
    if (activeConvoId) {
      loadMessages(activeConvoId, 0, false);
    } else {
      setMessages([]);
    }
  }, [activeConvoId, loadMessages]);

  // Realtime subscription for active conversation + typing broadcast
  useEffect(() => {
    if (!activeConvoId) return;
    const supabase = getSupabase();
    const ch = supabase
      .channel(`dm-room:${activeConvoId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'direct_messages',
          filter: `conversation_id=eq.${activeConvoId}`,
        },
        async (payload) => {
          const inserted = payload.new as DirectMessage;
          const { data: full } = await supabase
            .from('direct_messages')
            .select('*, sender:profiles!direct_messages_sender_id_fkey(*)')
            .eq('id', inserted.id)
            .single();
          if (full) {
            const [hydrated] = await hydrateMessages([full as unknown as DirectMessage]);
            setMessages((prev) => (prev.some((m) => m.id === hydrated.id) ? prev : [...prev, hydrated]));
            markConversationRead(activeConvoId);
            setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
          }
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'message_reactions', filter: 'message_type=eq.dm' },
        () => {
          loadMessages(activeConvoId, 0, false);
        }
      )
      .on('broadcast', { event: 'typing' }, ({ payload }) => {
        if (payload?.userId && payload.userId !== currentUser.id) {
          setTypingPeer(String(payload.displayName || 'User'));
          if (typingTimerRef.current) window.clearTimeout(typingTimerRef.current);
          typingTimerRef.current = window.setTimeout(() => setTypingPeer(null), 2200);
        }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(ch);
    };
  }, [activeConvoId, currentUser.id, hydrateMessages, loadMessages, markConversationRead]);

  // Search users for starting a new DM
  useEffect(() => {
    const clean = searchUsername.trim().toLowerCase().replace(/^@/, '');
    if (!clean) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      const supabase = getSupabase();
      const { data } = await supabase
        .from('profiles')
        .select('*')
        .neq('id', currentUser.id)
        .or(`username.ilike.%${clean}%,display_name.ilike.%${clean}%`)
        .limit(8);
      setSearchResults((data || []) as Profile[]);
    }, 200);
    return () => clearTimeout(timer);
  }, [currentUser.id, searchUsername]);

  const startConversationWith = async (targetUserId: string) => {
    setError(null);
    try {
      const supabase = getSupabase();
      const { data: convoId, error: rpcErr } = await supabase.rpc('get_or_create_dm_conversation', {
        p_target_user_id: targetUserId,
      });
      if (rpcErr) throw rpcErr;
      setSearchUsername('');
      setSearchResults([]);
      setActiveConvoId(convoId as string);
      await loadConversations();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start conversation.');
    }
  };

  const broadcastTyping = () => {
    if (!activeConvoId) return;
    const supabase = getSupabase();
    supabase.channel(`dm-room:${activeConvoId}`).send({
      type: 'broadcast',
      event: 'typing',
      payload: { userId: currentUser.id, displayName: currentUser.display_name },
    });
  };

  const handleSendDm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeConvoId || (!text.trim() && !pendingFile)) return;
    setSending(true);
    setError(null);

    try {
      const supabase = getSupabase();
      const { data: msg, error: msgErr } = await supabase
        .from('direct_messages')
        .insert({
          conversation_id: activeConvoId,
          sender_id: currentUser.id,
          content: text.trim(),
        })
        .select('*, sender:profiles!direct_messages_sender_id_fkey(*)')
        .single();
      if (msgErr) throw msgErr;

      let uploadedAttachments: AttachmentRecord[] = [];
      if (pendingFile) {
        const ext = pendingFile.name.split('.').pop() || 'bin';
        const storagePath = `${currentUser.id}/dm/${activeConvoId}/${crypto.randomUUID()}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from('chat-attachments')
          .upload(storagePath, pendingFile, { contentType: pendingFile.type });
        if (upErr) throw upErr;

        const { data: attRow, error: attErr } = await supabase
          .from('attachments')
          .insert({
            uploader_id: currentUser.id,
            context_type: 'dm',
            context_id: activeConvoId,
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

      const fullMsg: DirectMessage = {
        ...(msg as unknown as DirectMessage),
        attachments: uploadedAttachments,
        reactions: [],
      };
      setMessages((prev) => (prev.some((m) => m.id === fullMsg.id) ? prev : [...prev, fullMsg]));
      setText('');
      setPendingFile(null);
      setShowEmojiPicker(false);
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message.');
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
        message_type: 'dm',
        message_id: messageId,
        user_id: currentUser.id,
        emoji_shortcode: shortcode,
      });
    }
    setReactingToMsgId(null);
  };

  const activeConvo = conversations.find((c) => c.id === activeConvoId);

  return (
    <div className="flex h-full min-h-0">
      {/* Conversations List Sidebar */}
      <aside className="w-72 border-r border-white/8 bg-[#0E1117] flex flex-col shrink-0">
        <div className="p-4 border-b border-white/8">
          <h2 className="font-display text-sm font-bold text-white mb-3">Direct Messages</h2>
          <div className="relative">
            <div className="flex items-center gap-2 bg-[#0B0D11] border border-white/10 rounded-lg px-3 py-1.5">
              <Search className="w-3.5 h-3.5 text-[#9CA3AF]" />
              <input
                type="text"
                value={searchUsername}
                onChange={(e) => setSearchUsername(e.target.value)}
                placeholder="Start DM with @user..."
                className="w-full bg-transparent text-xs text-white placeholder-[#6B7280] focus:outline-none"
              />
            </div>

            {searchResults.length > 0 && (
              <div className="absolute left-0 right-0 top-10 z-20 bg-[#141821] border border-white/10 rounded-xl shadow-xl divide-y divide-white/8 overflow-hidden">
                {searchResults.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => startConversationWith(u.id)}
                    className="w-full flex items-center gap-2.5 p-2.5 hover:bg-white/5 text-left"
                  >
                    <Avatar src={u.avatar_url} name={u.display_name} size="sm" />
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-white truncate">{u.display_name}</div>
                      <div className="text-[11px] text-[#9CA3AF] truncate">@{u.username}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {loadingConvos ? (
            <div className="py-8 flex justify-center">
              <Loader2 className="w-4 h-4 animate-spin text-[#5B7CFA]" />
            </div>
          ) : conversations.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-[#9CA3AF]">
              No conversations yet. Search a username above to start chatting.
            </div>
          ) : (
            conversations.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setActiveConvoId(c.id)}
                className={`w-full flex items-center justify-between gap-2.5 p-2.5 rounded-xl text-left transition-colors ${
                  c.id === activeConvoId ? 'bg-[#181E2E] text-white' : 'text-[#D1D5DB] hover:bg-white/5'
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <Avatar
                    src={c.other_user?.avatar_url}
                    name={c.other_user?.display_name || 'User'}
                    size="sm"
                  />
                  <div className="min-w-0">
                    <div className="text-xs font-semibold truncate">
                      {c.other_user?.display_name || 'User'}
                    </div>
                    <div className="text-[11px] text-[#9CA3AF] truncate">
                      @{c.other_user?.username || 'user'}
                    </div>
                  </div>
                </div>

                {c.unread && (
                  <span className="text-[10px] font-semibold text-[#7C96FF] shrink-0">New</span>
                )}
              </button>
            ))
          )}
        </div>
      </aside>

      {/* Active DM Thread (Strictly Text & Attachments — NO DM Calls) */}
      <section className="flex-1 flex flex-col min-w-0 bg-[#0B0D11]">
        {activeConvo ? (
          <>
            <header className="h-14 px-5 border-b border-white/8 flex items-center justify-between shrink-0">
              <button
                type="button"
                onClick={() => activeConvo.other_user && onOpenProfile(activeConvo.other_user.id)}
                className="flex items-center gap-3 text-left"
              >
                <Avatar
                  src={activeConvo.other_user?.avatar_url}
                  name={activeConvo.other_user?.display_name || 'User'}
                  size="sm"
                />
                <div>
                  <div className="text-sm font-semibold text-white hover:underline">
                    {activeConvo.other_user?.display_name}
                  </div>
                  <div className="text-[11px] text-[#9CA3AF]">
                    @{activeConvo.other_user?.username} · Text &amp; 24h attachments
                  </div>
                </div>
              </button>
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
                    onClick={() => loadMessages(activeConvo.id, messages.length, true)}
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
                  Say hello to @{activeConvo.other_user?.username}. Messages update in real time.
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
                      <Avatar
                        src={msg.sender?.avatar_url}
                        name={msg.sender?.display_name || 'U'}
                        size="sm"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 text-xs mb-0.5">
                          <span className="font-semibold text-white">
                            {msg.sender?.display_name || 'User'}
                          </span>
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

                      <button
                        type="button"
                        onClick={() =>
                          setReactingToMsgId((cur) => (cur === msg.id ? null : msg.id))
                        }
                        className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-[#9CA3AF] hover:text-white hover:bg-white/5 transition-opacity"
                        title="Add reaction"
                      >
                        <Smile className="w-3.5 h-3.5" />
                      </button>

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

            {/* Typing & Composer */}
            <div className="px-5 pb-4 pt-2 border-t border-white/8 relative">
              {typingPeer && (
                <div className="text-[11px] text-[#9CA3AF] mb-1.5">{typingPeer} is typing...</div>
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

              <form onSubmit={handleSendDm} className="flex items-center gap-2 bg-[#12151C] border border-white/10 rounded-xl px-3 py-2">
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
                  title="Insert custom emoji"
                >
                  <Smile className="w-4 h-4" />
                </button>

                <input
                  type="text"
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                    broadcastTyping();
                  }}
                  placeholder={`Message @${activeConvo.other_user?.username}...`}
                  maxLength={4000}
                  className="flex-1 bg-transparent text-sm text-white placeholder-[#6B7280] focus:outline-none"
                />

                <button
                  type="submit"
                  disabled={sending || (!text.trim() && !pendingFile)}
                  className="p-2 rounded-lg bg-[#5B7CFA] hover:bg-[#4B6CF0] disabled:opacity-40 text-white transition-colors"
                >
                  <Send className="w-4 h-4" />
                </button>
              </form>
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
            <Mail className="w-8 h-8 text-[#6B7280] mb-3" />
            <h3 className="font-display text-base font-semibold text-white mb-1">
              Private Direct Messages
            </h3>
            <p className="text-xs text-[#9CA3AF] max-w-sm">
              Select an existing conversation or search a username to send real-time private messages. Voice and video calls live inside community server channels.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
