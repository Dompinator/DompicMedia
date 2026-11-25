import React, { useCallback, useEffect, useState } from 'react';
import {
  Bell,
  Compass,
  Home,
  Loader2,
  Mail,
  Plus,
  Settings,
  User as UserIcon,
  X,
} from 'lucide-react';
import { AppView, GlobalEmoji, Profile, Server } from './types';
import { clearBrowserSupabaseConfig, getSupabase, initSupabase } from './lib/supabase';
import { loadSoundsManifest, playSound } from './lib/sounds';
import { StartupOverlay } from './components/StartupOverlay';
import { VesperLogoMark } from './components/VesperLogo';
import { SupabaseSetupScreen } from './components/SupabaseSetupScreen';
import { AuthView } from './components/AuthView';
import { SocialFeedView } from './components/SocialFeedView';
import { ProfileView } from './components/ProfileView';
import { ExplorePeopleView } from './components/ExplorePeopleView';
import { MessagesView } from './components/MessagesView';
import { InboxView } from './components/InboxView';
import { ServerWorkspaceView } from './components/ServerWorkspaceView';
import { SettingsView } from './components/SettingsView';
import { Avatar } from './components/Avatar';

export default function App() {
  const [booting, setBooting] = useState(true);
  const [supabaseReady, setSupabaseReady] = useState(false);
  const [forceSetup, setForceSetup] = useState(false);
  const [authLoadError, setAuthLoadError] = useState<string | null>(null);

  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<Profile | null>(null);
  const [servers, setServers] = useState<Server[]>([]);
  const [globalEmojis, setGlobalEmojis] = useState<GlobalEmoji[]>([]);
  const [unreadInbox, setUnreadInbox] = useState(0);
  const [unreadDms, setUnreadDms] = useState(0);

  const [view, setView] = useState<AppView>({ kind: 'feed' });
  const [showCreateServer, setShowCreateServer] = useState(false);
  const [newServerName, setNewServerName] = useState('');
  const [newServerDesc, setNewServerDesc] = useState('');
  const [creatingServer, setCreatingServer] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const loadUserWorkspace = useCallback(async (uid: string) => {
    const supabase = getSupabase();
    let profRes = await supabase.from('profiles').select('*').eq('id', uid).maybeSingle();

    // Repair older Auth accounts that do not yet have a matching profile row.
    if (!profRes.error && !profRes.data) {
      const { data: authUserResult } = await supabase.auth.getUser();
      const authUser = authUserResult.user;
      const metadata = authUser?.user_metadata || {};
      const metadataUsername = String(metadata.username || '')
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '')
        .slice(0, 24);
      const fallbackUsername = 'user_' + uid.replace(/-/g, '').slice(0, 10);
      const username = metadataUsername.length >= 3 ? metadataUsername : fallbackUsername;
      const displayName = String(metadata.display_name || authUser?.email?.split('@')[0] || username)
        .trim().slice(0, 48) || username;

      let insertResult = await supabase.from('profiles').insert({ id: uid, username, display_name: displayName });
      if (insertResult.error && username !== fallbackUsername) {
        insertResult = await supabase.from('profiles').insert({
          id: uid, username: fallbackUsername, display_name: displayName,
        });
      }
      if (insertResult.error) {
        throw new Error('You are signed in, but your profile could not be created: ' + insertResult.error.message);
      }
      profRes = await supabase.from('profiles').select('*').eq('id', uid).single();
    }

    if (profRes.error) {
      throw new Error('Signed in, but your profile could not be loaded: ' + profRes.error.message);
    }
    if (!profRes.data) {
      throw new Error('Signed in, but your profile is missing. Please contact the site administrator.');
    }

    const [srvRes, emojiRes] = await Promise.all([
      supabase.from('server_members').select('server:servers(*)').eq('user_id', uid),
      supabase.from('global_emojis').select('*').order('shortcode', { ascending: true }),
    ]);
    setCurrentUser(profRes.data as Profile);
    const srvList = (srvRes.data || [])
      .map((r) => r.server as unknown as Server)
      .filter(Boolean);
    setServers(srvList);
    setGlobalEmojis((emojiRes.data || []) as GlobalEmoji[]);

    // Fetch initial unread counts
    const [notifsCountRes, frCountRes, invCountRes] = await Promise.all([
      supabase
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .eq('recipient_id', uid)
        .is('read_at', null),
      supabase
        .from('friend_requests')
        .select('*', { count: 'exact', head: true })
        .eq('receiver_id', uid)
        .eq('status', 'pending'),
      supabase
        .from('server_invitations')
        .select('*', { count: 'exact', head: true })
        .eq('invitee_id', uid)
        .eq('status', 'pending'),
    ]);
    setUnreadInbox(
      (notifsCountRes.count || 0) + (frCountRes.count || 0) + (invCountRes.count || 0)
    );
  }, []);

  const refreshServers = useCallback(async () => {
    if (!sessionUserId) return;
    const { data } = await getSupabase()
      .from('server_members')
      .select('server:servers(*)')
      .eq('user_id', sessionUserId);
    setServers((data || []).map((r) => r.server as unknown as Server).filter(Boolean));
  }, [sessionUserId]);

  const refreshEmojis = useCallback(async () => {
    const { data } = await getSupabase()
      .from('global_emojis')
      .select('*')
      .order('shortcode', { ascending: true });
    setGlobalEmojis((data || []) as GlobalEmoji[]);
  }, []);

  const bootstrap = useCallback(async () => {
    setBooting(true);
    const { client } = await initSupabase();
    if (!client) {
      setSupabaseReady(false);
      setBooting(false);
      return;
    }
    setSupabaseReady(true);
    const { data } = await client.auth.getSession();
    const uid = data.session?.user?.id || null;
    setSessionUserId(uid);
    if (uid) {
      await loadUserWorkspace(uid);
    }
    setBooting(false);
  }, [loadUserWorkspace]);

  useEffect(() => {
    loadSoundsManifest();
    bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const interactive = target.closest('button, a, [role="button"]');
      if (!interactive) return;
      if ((interactive as HTMLButtonElement).disabled) return;
      if (interactive.closest('[data-sound-custom="true"]')) return;
      playSound('click');
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  useEffect(() => {
    if (!supabaseReady) return;
    const supabase = getSupabase();
    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, session) => {
      const uid = session?.user?.id || null;
      setSessionUserId(uid);
      if (uid) {
        try {
          await loadUserWorkspace(uid);
        } catch (err) {
          console.error('DompicMEDIA account loading failed:', err);
          setAuthLoadError(err instanceof Error ? err.message : 'Could not load your account.');
          setCurrentUser(null);
        }
      } else {
        setAuthLoadError(null);
        setCurrentUser(null);
        setServers([]);
        setView({ kind: 'feed' });
      }
    });
    return () => {
      sub.subscription.unsubscribe();
    };
  }, [loadUserWorkspace, supabaseReady]);

  const openProfileByUsername = async (username: string) => {
    const { data } = await getSupabase()
      .from('profiles')
      .select('id')
      .eq('username', username.toLowerCase())
      .maybeSingle();
    if (data?.id) {
      setView({ kind: 'profile', userId: data.id as string });
    }
  };

  const handleCreateServer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newServerName.trim()) return;
    setCreatingServer(true);
    setServerError(null);
    try {
      const { data: serverId, error: rpcErr } = await getSupabase().rpc(
        'create_server_with_defaults',
        {
          p_name: newServerName.trim(),
          p_description: newServerDesc.trim(),
        }
      );
      if (rpcErr) throw rpcErr;
      await refreshServers();
      setNewServerName('');
      setNewServerDesc('');
      setShowCreateServer(false);
      if (serverId) {
        setView({ kind: 'server', serverId: serverId as string });
      }
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Failed to create server.');
    } finally {
      setCreatingServer(false);
    }
  };

  return (
    <>
      <StartupOverlay />

      {booting ? (
        <div className="min-h-screen bg-[#0B0D11] flex items-center justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-[#5B7CFA]" />
        </div>
      ) : !supabaseReady || forceSetup ? (
        <SupabaseSetupScreen
          onConnected={() => {
            setForceSetup(false);
            bootstrap();
          }}
          onClose={() => setForceSetup(false)}
        />
      ) : !sessionUserId || !currentUser ? (
        <AuthView
          externalError={authLoadError}
          onOpenSetup={() => {
            clearBrowserSupabaseConfig();
            setForceSetup(true);
          }}
        />
      ) : (
        <div className="h-screen w-screen overflow-hidden bg-[#0B0D11] text-[#F3F4F6] flex flex-col md:flex-row">
          {/* Desktop Navigation & Server Rail */}
          <nav
            aria-label="Primary Navigation"
            className="hidden md:flex flex-col items-center w-[72px] bg-[#0E1117] border-r border-white/8 py-3 gap-2 shrink-0"
          >
            <button
              type="button"
              onClick={() => setView({ kind: 'feed' })}
              title="DompicMEDIA Home Feed"
              className="mb-2 rounded-xl focus-visible:outline-2 focus-visible:outline-[#5B7CFA]"
            >
              <VesperLogoMark className="w-10 h-10" />
            </button>

            <RailButton
              active={view.kind === 'feed'}
              onClick={() => setView({ kind: 'feed' })}
              label="Home Feed"
            >
              <Home className="w-5 h-5" />
            </RailButton>

            <RailButton
              active={view.kind === 'explore'}
              onClick={() => setView({ kind: 'explore' })}
              label="Explore People & Emojis"
            >
              <Compass className="w-5 h-5" />
            </RailButton>

            <RailButton
              active={view.kind === 'messages'}
              onClick={() => setView({ kind: 'messages' })}
              label="Direct Messages"
              badge={unreadDms}
            >
              <Mail className="w-5 h-5" />
            </RailButton>

            <RailButton
              active={view.kind === 'inbox'}
              onClick={() => setView({ kind: 'inbox' })}
              label="Inbox & Notifications"
              badge={unreadInbox}
            >
              <Bell className="w-5 h-5" />
            </RailButton>

            <RailButton
              active={view.kind === 'profile' && view.userId === currentUser.id}
              onClick={() => setView({ kind: 'profile', userId: currentUser.id })}
              label="Your Profile"
            >
              <UserIcon className="w-5 h-5" />
            </RailButton>

            <div className="w-8 h-px bg-white/10 my-1.5" />

            {/* Joined Community Servers */}
            <div className="flex-1 w-full overflow-y-auto flex flex-col items-center gap-2.5 px-2">
              {servers.map((srv) => {
                const isActive = view.kind === 'server' && view.serverId === srv.id;
                return (
                  <button
                    key={srv.id}
                    type="button"
                    onClick={() => setView({ kind: 'server', serverId: srv.id })}
                    title={srv.name}
                    className={`relative w-11 h-11 rounded-2xl flex items-center justify-center transition-all overflow-hidden border ${
                      isActive
                        ? 'border-[#5B7CFA] ring-2 ring-[#5B7CFA]/40'
                        : 'border-white/10 hover:border-white/25'
                    }`}
                  >
                    <Avatar src={srv.icon_url} name={srv.name} size="md" className="w-full h-full rounded-none border-0" />
                  </button>
                );
              })}

              <button
                type="button"
                onClick={() => setShowCreateServer(true)}
                title="Create a Community Server"
                className="w-11 h-11 rounded-2xl bg-[#12151C] border border-dashed border-white/15 hover:border-[#5B7CFA] text-[#9CA3AF] hover:text-white flex items-center justify-center transition-colors shrink-0"
              >
                <Plus className="w-5 h-5" />
              </button>
            </div>

            <div className="pt-2 flex flex-col items-center gap-2">
              <RailButton
                active={view.kind === 'settings'}
                onClick={() => setView({ kind: 'settings' })}
                label="Settings"
              >
                <Settings className="w-5 h-5" />
              </RailButton>

              <button
                type="button"
                onClick={() => setView({ kind: 'profile', userId: currentUser.id })}
                title={`@${currentUser.username}`}
              >
                <Avatar src={currentUser.avatar_url} name={currentUser.display_name} size="sm" />
              </button>
            </div>
          </nav>

          {/* Main Workspace Area */}
          <main className="flex-1 min-w-0 min-h-0 overflow-y-auto flex flex-col">
            {view.kind === 'feed' && (
              <SocialFeedView
                currentUser={currentUser}
                globalEmojis={globalEmojis}
                onOpenProfile={(uid) => setView({ kind: 'profile', userId: uid })}
                onOpenProfileByUsername={openProfileByUsername}
              />
            )}

            {view.kind === 'explore' && (
              <ExplorePeopleView
                currentUser={currentUser}
                globalEmojis={globalEmojis}
                onOpenProfile={(uid) => setView({ kind: 'profile', userId: uid })}
                onRefreshEmojis={refreshEmojis}
              />
            )}

            {view.kind === 'messages' && (
              <div className="flex-1 min-h-0 flex flex-col">
                <MessagesView
                  currentUser={currentUser}
                  globalEmojis={globalEmojis}
                  initialConversationId={view.conversationId}
                  onOpenProfile={(uid) => setView({ kind: 'profile', userId: uid })}
                  onUnreadCountChange={setUnreadDms}
                />
              </div>
            )}

            {view.kind === 'inbox' && (
              <InboxView
                currentUser={currentUser}
                onOpenProfile={(uid) => setView({ kind: 'profile', userId: uid })}
                onJoinedServer={async (srvId) => {
                  await refreshServers();
                  setView({ kind: 'server', serverId: srvId });
                }}
                onUnreadCountChange={setUnreadInbox}
              />
            )}

            {view.kind === 'profile' && (
              <ProfileView
                profileId={view.userId}
                currentUser={currentUser}
                globalEmojis={globalEmojis}
                onProfileUpdated={(updated) => setCurrentUser(updated)}
                onStartDm={(convoId) => setView({ kind: 'messages', conversationId: convoId })}
                onOpenProfile={(uid) => setView({ kind: 'profile', userId: uid })}
              />
            )}

            {view.kind === 'server' && (
              <div className="flex-1 min-h-0 flex flex-col">
                <ServerWorkspaceView
                  key={view.serverId}
                  serverId={view.serverId}
                  initialChannelId={view.channelId}
                  currentUser={currentUser}
                  globalEmojis={globalEmojis}
                  onOpenProfile={(uid) => setView({ kind: 'profile', userId: uid })}
                  onServerLeftOrDeleted={async () => {
                    await refreshServers();
                    setView({ kind: 'feed' });
                  }}
                  onServerUpdated={refreshServers}
                />
              </div>
            )}

            {view.kind === 'settings' && (
              <SettingsView
                currentUser={currentUser}
                onSignedOut={() => setSessionUserId(null)}
                onResetConnection={() => setForceSetup(true)}
              />
            )}
          </main>

          {/* Mobile Bottom Navigation */}
          <nav
            aria-label="Mobile Navigation"
            className="md:hidden h-14 bg-[#0E1117] border-t border-white/8 flex items-center justify-around px-2 shrink-0"
          >
            <button
              type="button"
              onClick={() => setView({ kind: 'feed' })}
              className={`p-2 rounded-lg ${view.kind === 'feed' ? 'text-[#5B7CFA]' : 'text-[#9CA3AF]'}`}
              aria-label="Feed"
            >
              <Home className="w-5 h-5" />
            </button>
            <button
              type="button"
              onClick={() => setView({ kind: 'explore' })}
              className={`p-2 rounded-lg ${view.kind === 'explore' ? 'text-[#5B7CFA]' : 'text-[#9CA3AF]'}`}
              aria-label="Explore"
            >
              <Compass className="w-5 h-5" />
            </button>
            <button
              type="button"
              onClick={() => setView({ kind: 'messages' })}
              className={`p-2 rounded-lg relative ${view.kind === 'messages' ? 'text-[#5B7CFA]' : 'text-[#9CA3AF]'}`}
              aria-label="Messages"
            >
              <Mail className="w-5 h-5" />
              {unreadDms > 0 && (
                <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-[#5B7CFA]" />
              )}
            </button>
            <button
              type="button"
              onClick={() => setView({ kind: 'inbox' })}
              className={`p-2 rounded-lg relative ${view.kind === 'inbox' ? 'text-[#5B7CFA]' : 'text-[#9CA3AF]'}`}
              aria-label="Inbox"
            >
              <Bell className="w-5 h-5" />
              {unreadInbox > 0 && (
                <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-[#EF4444]" />
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                if (servers[0]) setView({ kind: 'server', serverId: servers[0].id });
                else setShowCreateServer(true);
              }}
              className={`p-2 rounded-lg ${view.kind === 'server' ? 'text-[#5B7CFA]' : 'text-[#9CA3AF]'}`}
              aria-label="Servers"
            >
              <Plus className="w-5 h-5" />
            </button>
            <button
              type="button"
              onClick={() => setView({ kind: 'profile', userId: currentUser.id })}
              className="p-1.5 rounded-lg"
              aria-label="Profile"
            >
              <Avatar src={currentUser.avatar_url} name={currentUser.display_name} size="xs" />
            </button>
          </nav>

          {/* Create Server Modal */}
          {showCreateServer && (
            <div className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
              <form
                onSubmit={handleCreateServer}
                className="w-full max-w-md bg-[#12151C] border border-white/10 rounded-2xl p-6 space-y-4"
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-display text-base font-bold text-white">
                    Create a Community Server
                  </h3>
                  <button
                    type="button"
                    onClick={() => setShowCreateServer(false)}
                    className="text-[#9CA3AF] hover:text-white"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div>
                  <label className="block text-xs font-medium text-[#D1D5DB] mb-1.5">
                    Server Name
                  </label>
                  <input
                    type="text"
                    required
                    minLength={2}
                    maxLength={60}
                    value={newServerName}
                    onChange={(e) => setNewServerName(e.target.value)}
                    placeholder="Design Guild"
                    className="w-full rounded-lg bg-[#0B0D11] border border-white/10 px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-[#5B7CFA]"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-[#D1D5DB] mb-1.5">
                    Description (optional)
                  </label>
                  <textarea
                    rows={2}
                    value={newServerDesc}
                    onChange={(e) => setNewServerDesc(e.target.value)}
                    placeholder="What is this community about?"
                    className="w-full rounded-lg bg-[#0B0D11] border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:border-[#5B7CFA]"
                  />
                </div>

                {serverError && <p className="text-xs text-[#FCA5A5]">{serverError}</p>}

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowCreateServer(false)}
                    className="px-4 py-2 text-xs text-[#9CA3AF]"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={creatingServer}
                    className="px-4 py-2 rounded-lg bg-[#5B7CFA] hover:bg-[#4B6CF0] text-xs font-semibold text-white"
                  >
                    {creatingServer ? 'Creating...' : 'Create Server'}
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function RailButton({
  active,
  onClick,
  label,
  badge = 0,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  badge?: number;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`relative w-11 h-11 rounded-xl flex items-center justify-center transition-colors focus-visible:outline-2 focus-visible:outline-[#5B7CFA] ${
        active
          ? 'bg-[#5B7CFA] text-white'
          : 'text-[#9CA3AF] hover:text-white hover:bg-white/6'
      }`}
    >
      {children}
      {badge > 0 && (
        <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-[#EF4444] text-[10px] font-mono font-bold text-white flex items-center justify-center">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  );
}
