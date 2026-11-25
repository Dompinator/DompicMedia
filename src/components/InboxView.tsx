import React, { useCallback, useEffect, useState } from 'react';
import { Bell, Check, CheckCheck, Loader2, Server as ServerIcon, UserPlus, X } from 'lucide-react';
import { AppView, FriendRequest, NotificationItem, Profile, ServerInvitation } from '../types';
import { getSupabase } from '../lib/supabase';
import { formatRelativeTime } from '../lib/utils';
import { Avatar } from './Avatar';

interface InboxViewProps {
  currentUser: Profile;
  onOpenProfile: (userId: string) => void;
  onJoinedServer: (serverId: string) => void;
  /** Tells the app to recount the unread badges. */
  onChanged: () => void;
  navigate: (view: AppView) => void;
}

export function InboxView({
  currentUser,
  onOpenProfile,
  onJoinedServer,
  onChanged,
  navigate,
}: InboxViewProps) {
  const [friendRequests, setFriendRequests] = useState<FriendRequest[]>([]);
  const [serverInvites, setServerInvites] = useState<ServerInvitation[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadInbox = useCallback(async () => {
    try {
      const supabase = getSupabase();
      const [frRes, invRes, notifRes] = await Promise.all([
        supabase
          .from('friend_requests')
          .select('*, sender:profiles!friend_requests_sender_id_fkey(*)')
          .eq('receiver_id', currentUser.id)
          .eq('status', 'pending')
          .order('created_at', { ascending: false }),
        supabase
          .from('server_invitations')
          .select('*, server:servers(*), inviter:profiles!server_invitations_inviter_id_fkey(*)')
          .eq('invitee_id', currentUser.id)
          .eq('status', 'pending')
          .order('created_at', { ascending: false }),
        supabase
          .from('notifications')
          .select('*, actor:profiles!notifications_actor_id_fkey(*)')
          .eq('recipient_id', currentUser.id)
          .order('created_at', { ascending: false })
          .limit(50),
      ]);

      const frs = (frRes.data || []) as unknown as FriendRequest[];
      const invs = (invRes.data || []) as unknown as ServerInvitation[];
      const notifs = (notifRes.data || []) as unknown as NotificationItem[];

      setFriendRequests(frs);
      setServerInvites(invs);
      setNotifications(notifs);
      onChanged();
    } finally {
      setLoading(false);
    }
  }, [currentUser.id, onChanged]);

  useEffect(() => {
    loadInbox();
  }, [loadInbox]);

  useEffect(() => {
    const supabase = getSupabase();
    const ch = supabase
      .channel(`vesper-inbox-${currentUser.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${currentUser.id}` },
        () => loadInbox()
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'server_invitations', filter: `invitee_id=eq.${currentUser.id}` },
        () => loadInbox()
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'friend_requests', filter: `receiver_id=eq.${currentUser.id}` },
        () => loadInbox()
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [currentUser.id, loadInbox]);

  const handleFriendDecision = async (reqId: string, accept: boolean) => {
    setBusyId(reqId);
    setError(null);
    try {
      const supabase = getSupabase();
      const { error: rpcErr } = await supabase.rpc(
        accept ? 'accept_friend_request' : 'decline_friend_request',
        { p_request_id: reqId }
      );
      if (rpcErr) throw rpcErr;
      await loadInbox();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed.');
    } finally {
      setBusyId(null);
    }
  };

  const handleServerInviteDecision = async (invId: string, accept: boolean) => {
    setBusyId(invId);
    setError(null);
    try {
      const supabase = getSupabase();
      if (accept) {
        const { data: serverId, error: rpcErr } = await supabase.rpc('accept_server_invitation', {
          p_invite_id: invId,
        });
        if (rpcErr) throw rpcErr;
        await loadInbox();
        if (serverId) onJoinedServer(serverId as string);
      } else {
        const { error: rpcErr } = await supabase.rpc('decline_server_invitation', {
          p_invite_id: invId,
        });
        if (rpcErr) throw rpcErr;
        await loadInbox();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invitation action failed.');
    } finally {
      setBusyId(null);
    }
  };

  const markAllRead = async () => {
    const supabase = getSupabase();
    const now = new Date().toISOString();
    await supabase
      .from('notifications')
      .update({ read_at: now })
      .eq('recipient_id', currentUser.id)
      .is('read_at', null);
    setNotifications((prev) => prev.map((n) => ({ ...n, read_at: n.read_at || now })));
    onChanged();
  };

  const markRead = async (id: string) => {
    const supabase = getSupabase();
    const now = new Date().toISOString();
    await supabase.from('notifications').update({ read_at: now }).eq('id', id);
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read_at: now } : n)));
    onChanged();
  };

  const openNotification = (n: NotificationItem) => {
    if (!n.read_at) markRead(n.id);
    if (n.type === 'mention' && n.metadata?.context === 'channel') {
      navigate({
        kind: 'server',
        serverId: String(n.metadata.server_id),
        channelId: String(n.metadata.channel_id),
      });
    } else if (['mention', 'post_like', 'post_reply', 'post_repost'].includes(n.type) && n.entity_id) {
      navigate({ kind: 'post', postId: n.entity_id });
    } else if (n.type === 'friend_accepted' && n.actor_id) {
      onOpenProfile(n.actor_id);
    }
  };

  const describeNotification = (n: NotificationItem): string => {
    const name = n.actor?.display_name || `@${n.actor?.username || 'someone'}`;
    switch (n.type) {
      case 'friend_request':
        return `${name} sent you a friend request`;
      case 'friend_accepted':
        return `${name} accepted your friend request`;
      case 'server_invite':
        return `${name} invited you to join ${String(n.metadata?.server_name || 'a server')}`;
      case 'post_like':
        return `${name} liked your post`;
      case 'post_reply':
        return `${name} replied to your post`;
      case 'post_repost':
        return `${name} reposted your post`;
      case 'mention':
        return `${name} mentioned you`;
      default:
        return 'New notification';
    }
  };

  return (
    <div className="max-w-2xl mx-auto w-full px-4 py-6 space-y-6">
      <div className="flex items-center justify-between border-b border-white/8 pb-4">
        <h2 className="font-display text-lg font-bold text-white">Inbox &amp; Notifications</h2>
        {notifications.some((n) => !n.read_at) && (
          <button
            type="button"
            onClick={markAllRead}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-[#7C96FF] hover:text-white transition-colors"
          >
            <CheckCheck className="w-4 h-4" />
            <span>Mark all read</span>
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-xl bg-[#EF4444]/10 border border-[#EF4444]/30 px-4 py-3 text-xs text-[#FCA5A5]">
          {error}
        </div>
      )}

      {loading ? (
        <div className="py-12 flex justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-[#5B7CFA]" />
        </div>
      ) : (
        <>
          {/* Pending Server Invitations */}
          {serverInvites.length > 0 && (
            <section className="space-y-2.5">
              <h3 className="text-xs font-semibold text-[#9CA3AF] flex items-center gap-1.5">
                <ServerIcon className="w-3.5 h-3.5 text-[#5B7CFA]" />
                <span>Server Invitations ({serverInvites.length})</span>
              </h3>
              <div className="divide-y divide-white/8 bg-[#12151C] border border-white/8 rounded-2xl overflow-hidden">
                {serverInvites.map((inv) => (
                  <div key={inv.id} className="p-4 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <Avatar src={inv.server?.icon_url} name={inv.server?.name || 'S'} size="md" />
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-white truncate">
                          {inv.server?.name || 'Community Server'}
                        </div>
                        <div className="text-xs text-[#9CA3AF]">
                          Invited by @{inv.inviter?.username || 'member'} ·{' '}
                          <span className="font-mono">{formatRelativeTime(inv.created_at)}</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        disabled={busyId === inv.id}
                        onClick={() => handleServerInviteDecision(inv.id, false)}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[#181C25] border border-white/10 hover:border-white/25 text-xs font-medium text-[#D1D5DB]"
                      >
                        <X className="w-3.5 h-3.5" />
                        <span>Decline</span>
                      </button>
                      <button
                        type="button"
                        disabled={busyId === inv.id}
                        onClick={() => handleServerInviteDecision(inv.id, true)}
                        className="inline-flex items-center gap-1 px-3.5 py-1.5 rounded-lg bg-[#5B7CFA] hover:bg-[#4B6CF0] text-xs font-semibold text-white"
                      >
                        <Check className="w-3.5 h-3.5" />
                        <span>Accept</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Pending Friend Requests */}
          {friendRequests.length > 0 && (
            <section className="space-y-2.5">
              <h3 className="text-xs font-semibold text-[#9CA3AF] flex items-center gap-1.5">
                <UserPlus className="w-3.5 h-3.5 text-[#22C55E]" />
                <span>Friend Requests ({friendRequests.length})</span>
              </h3>
              <div className="divide-y divide-white/8 bg-[#12151C] border border-white/8 rounded-2xl overflow-hidden">
                {friendRequests.map((req) => (
                  <div key={req.id} className="p-4 flex flex-wrap items-center justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => req.sender && onOpenProfile(req.sender.id)}
                      className="flex items-center gap-3 min-w-0 text-left"
                    >
                      <Avatar
                        src={req.sender?.avatar_url}
                        name={req.sender?.display_name || 'U'}
                        size="md"
                      />
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-white truncate">
                          {req.sender?.display_name}
                        </div>
                        <div className="text-xs text-[#9CA3AF]">
                          @{req.sender?.username} ·{' '}
                          <span className="font-mono">{formatRelativeTime(req.created_at)}</span>
                        </div>
                      </div>
                    </button>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        disabled={busyId === req.id}
                        onClick={() => handleFriendDecision(req.id, false)}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[#181C25] border border-white/10 hover:border-white/25 text-xs font-medium text-[#D1D5DB]"
                      >
                        <X className="w-3.5 h-3.5" />
                        <span>Decline</span>
                      </button>
                      <button
                        type="button"
                        disabled={busyId === req.id}
                        onClick={() => handleFriendDecision(req.id, true)}
                        className="inline-flex items-center gap-1 px-3.5 py-1.5 rounded-lg bg-[#22C55E] hover:bg-[#16A34A] text-xs font-semibold text-white"
                      >
                        <Check className="w-3.5 h-3.5" />
                        <span>Accept</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Activity Notifications */}
          <section className="space-y-2.5">
            <h3 className="text-xs font-semibold text-[#9CA3AF] flex items-center gap-1.5">
              <Bell className="w-3.5 h-3.5" />
              <span>Activity</span>
            </h3>

            {notifications.length === 0 ? (
              <div className="bg-[#12151C] border border-white/8 rounded-2xl py-12 text-center">
                <Bell className="w-6 h-6 text-[#6B7280] mx-auto mb-2" />
                <p className="text-xs text-[#9CA3AF]">You&apos;re all caught up.</p>
              </div>
            ) : (
              <div className="divide-y divide-white/8 bg-[#12151C] border border-white/8 rounded-2xl overflow-hidden">
                {notifications.map((n) => (
                  <div
                    key={n.id}
                    onClick={() => openNotification(n)}
                    className={`p-4 flex items-center justify-between gap-3 cursor-pointer transition-colors ${
                      n.read_at ? 'opacity-75 hover:bg-white/[0.015]' : 'bg-[#5B7CFA]/[0.06] hover:bg-[#5B7CFA]/[0.09]'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Avatar
                        src={n.actor?.avatar_url}
                        name={n.actor?.display_name || 'V'}
                        size="sm"
                      />
                      <div className="min-w-0">
                        <p className="text-xs text-[#F3F4F6] truncate">{describeNotification(n)}</p>
                        {typeof n.metadata?.preview === 'string' && n.metadata.preview && (
                          <p className="text-[11px] text-[#D1D5DB] truncate">“{n.metadata.preview}”</p>
                        )}
                        <time className="block text-[11px] font-mono text-[#9CA3AF]">
                          {formatRelativeTime(n.created_at)}
                        </time>
                      </div>
                    </div>
                    {!n.read_at && (
                      <span className="text-[11px] font-medium text-[#7C96FF] shrink-0">Unread</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
