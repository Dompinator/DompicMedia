import { useCallback, useEffect, useRef, useState } from 'react';
import { AppView, DirectMessage, NotificationItem } from '../types';
import { getSupabase } from '../lib/supabase';
import { showBrowserNotification } from '../lib/browserNotifications';

/**
 * App-wide unread badges and system notifications. Runs for the whole signed-in session,
 * so it works no matter which view is open.
 */
export function useActivity(
  userId: string | null,
  activeConversationId: string | null,
  navigate: (view: AppView) => void
) {
  const [unreadDmIds, setUnreadDmIds] = useState<string[]>([]);
  const [unreadInbox, setUnreadInbox] = useState(0);
  const activeRef = useRef(activeConversationId);
  const navigateRef = useRef(navigate);
  activeRef.current = activeConversationId;
  navigateRef.current = navigate;

  const refresh = useCallback(async () => {
    if (!userId) {
      setUnreadDmIds([]);
      setUnreadInbox(0);
      return;
    }
    const supabase = getSupabase();
    const [dms, notifs, requests, invites] = await Promise.all([
      supabase.rpc('unread_dm_conversations'),
      supabase
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .eq('recipient_id', userId)
        // Requests and invites are counted from their own tables below.
        .not('type', 'in', '(friend_request,server_invite)')
        .is('read_at', null),
      supabase
        .from('friend_requests')
        .select('*', { count: 'exact', head: true })
        .eq('receiver_id', userId)
        .eq('status', 'pending'),
      supabase
        .from('server_invitations')
        .select('*', { count: 'exact', head: true })
        .eq('invitee_id', userId)
        .eq('status', 'pending'),
    ]);
    if (!dms.error) setUnreadDmIds((dms.data || []) as string[]);
    setUnreadInbox((notifs.count || 0) + (requests.count || 0) + (invites.count || 0));
  }, [userId]);

  useEffect(() => {
    refresh();
    if (!userId) return;
    const supabase = getSupabase();
    const nameOf = async (id: string | null) => {
      if (!id) return 'Someone';
      const { data } = await supabase.from('profiles').select('display_name').eq('id', id).maybeSingle();
      return (data?.display_name as string) || 'Someone';
    };

    // Row-level security limits these events to rows this user may read.
    const channel = supabase
      .channel(`activity:${userId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'direct_messages' }, async (payload) => {
        const msg = payload.new as DirectMessage;
        if (msg.sender_id === userId) return;
        refresh();
        if (document.visibilityState === 'visible' && activeRef.current === msg.conversation_id) return;
        const name = await nameOf(msg.sender_id);
        showBrowserNotification(name, msg.content.slice(0, 120) || 'Sent an attachment', `dm-${msg.conversation_id}`, () =>
          navigateRef.current({ kind: 'messages', conversationId: msg.conversation_id })
        );
      })
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'conversation_reads', filter: `user_id=eq.${userId}` },
        () => refresh()
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${userId}` },
        async (payload) => {
          refresh();
          if (payload.eventType !== 'INSERT') return;
          const n = payload.new as NotificationItem;
          if (n.type !== 'mention') return;
          const name = await nameOf(n.actor_id);
          showBrowserNotification(`${name} mentioned you`, String(n.metadata?.preview || ''), `mention-${n.id}`, () =>
            navigateRef.current(
              n.metadata?.context === 'channel'
                ? { kind: 'server', serverId: String(n.metadata.server_id), channelId: String(n.metadata.channel_id) }
                : { kind: 'post', postId: String(n.entity_id) }
            )
          );
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'friend_requests', filter: `receiver_id=eq.${userId}` },
        () => refresh()
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'server_invitations', filter: `invitee_id=eq.${userId}` },
        () => refresh()
      )
      .subscribe();

    // Catch up after the tab was asleep or offline.
    const onVisible = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      supabase.removeChannel(channel);
    };
  }, [refresh, userId]);

  return { unreadDmIds, unreadInbox, refresh };
}
