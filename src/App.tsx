import React, { useCallback, useEffect, useState } from 'react';
import {
  Bell,
  Compass,
  Flag,
  Home,
  Loader2,
  Mail,
  Menu,
  Plus,
  Settings,
  User as UserIcon,
  X,
} from 'lucide-react';
import { AppView, GlobalEmoji, Profile, ReportTargetType, Server } from './types';
import {
  clearBrowserSupabaseConfig,
  finishPasswordRecovery,
  getSupabase,
  initSupabase,
  passwordRecoveryPending,
} from './lib/supabase';
import { AppActions, AppContext } from './lib/appContext';
import { useActivity } from './hooks/useActivity';
import { PostDetailView } from './components/PostDetailView';
import { ReportDialog } from './components/ReportDialog';
import { ReportsAdminView } from './components/ReportsAdminView';
import { ResetPasswordView } from './components/ResetPasswordView';
import { MobileMenu } from './components/MobileMenu';
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

  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<Profile | null>(null);
  const [servers, setServers] = useState<Server[]>([]);
  const [globalEmojis, setGlobalEmojis] = useState<GlobalEmoji[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [blockedIds, setBlockedIds] = useState<Set<string>>(new Set());
  const [reportTarget, setReportTarget] = useState<{ type: ReportTargetType; id: string } | null>(null);
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const [recovering, setRecovering] = useState(passwordRecoveryPending);

  const [view, setView] = useState<AppView>({ kind: 'feed' });
  const [showCreateServer, setShowCreateServer] = useState(false);
  const [newServerName, setNewServerName] = useState('');
  const [newServerDesc, setNewServerDesc] = useState('');
  const [creatingServer, setCreatingServer] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    unreadDmIds,
    unreadInbox,
    refresh: refreshActivity,
  } = useActivity(currentUser ? sessionUserId : null, activeConversationId, setView);
  const unreadDms = unreadDmIds.length;

  useEffect(() => {
    document.title = unreadDms + unreadInbox > 0 ? `(${unreadDms + unreadInbox}) DompicMEDIA` : 'DompicMEDIA';
  }, [unreadDms, unreadInbox]);

  const loadUserWorkspace = useCallback(async (uid: string) => {
    const supabase = getSupabase();
    const [profRes, srvRes, emojiRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', uid).maybeSingle(),
      supabase
        .from('server_members')
        .select('server:servers(*)')
        .eq('user_id', uid),
      supabase.from('global_emojis').select('*').order('shortcode', { ascending: true }),
    ]);

    if (profRes.data) {
      setCurrentUser(profRes.data as Profile);
    }
    const srvList = (srvRes.data || [])
      .map((r) => r.server as unknown as Server)
      .filter(Boolean);
    setServers(srvList);
    setGlobalEmojis((emojiRes.data || []) as GlobalEmoji[]);

    const { data: blocks } = await supabase.from('user_blocks').select('blocked_id').eq('blocker_id', uid);
    setBlockedIds(new Set((blocks || []).map((b) => b.blocked_id as string)));
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
    const { data: sub } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'PASSWORD_RECOVERY') setRecovering(true);
      const uid = session?.user?.id || null;
      setSessionUserId(uid);
      if (uid) {
        await loadUserWorkspace(uid);
      } else {
        setCurrentUser(null);
        setServers([]);
        setBlockedIds(new Set());
        setShowMobileMenu(false);
        setReportTarget(null);
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

  const setBlocked = useCallback(
    async (userId: string, blocked: boolean): Promise<string | null> => {
      if (!sessionUserId) return 'Sign in first.';
      const supabase = getSupabase();
      const { error } = blocked
        ? await supabase.from('user_blocks').insert({ blocker_id: sessionUserId, blocked_id: userId })
        : await supabase.from('user_blocks').delete().eq('blocker_id', sessionUserId).eq('blocked_id', userId);
      if (error) return error.message;
      setBlockedIds((prev) => {
        const next = new Set(prev);
        if (blocked) next.add(userId);
        else next.delete(userId);
        return next;
      });
      refreshActivity();
      return null;
    },
    [refreshActivity, sessionUserId]
  );

  // Not memoized: openProfileByUsername only uses stable setters.
  const appActions: AppActions = {
    openProfileByUsername: (username) => openProfileByUsername(username),
    openHashtag: (tag) => setView({ kind: 'explore', query: tag }),
    report: (type, id) => setReportTarget({ type, id }),
    blockedIds,
    setBlocked,
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
    <AppContext.Provider value={appActions}>
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
        />
      ) : !sessionUserId || !currentUser ? (
        <AuthView
          onOpenSetup={() => {
            clearBrowserSupabaseConfig();
            setForceSetup(true);
          }}
        />
      ) : recovering ? (
        <ResetPasswordView
          onDone={() => {
            finishPasswordRecovery();
            setRecovering(false);
          }}
        />
      ) : (
        <div className="h-[100dvh] w-screen overflow-hidden bg-[#0B0D11] text-[#F3F4F6] flex flex-col md:flex-row">
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
              {currentUser.platform_role === 'platform_admin' && (
                <RailButton
                  active={view.kind === 'reports'}
                  onClick={() => setView({ kind: 'reports' })}
                  label="Reports"
                >
                  <Flag className="w-5 h-5" />
                </RailButton>
              )}

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
                initialQuery={view.query}
                onOpenProfileByUsername={openProfileByUsername}
              />
            )}

            {view.kind === 'messages' && (
              <div className="flex-1 min-h-0 flex flex-col">
                <MessagesView
                  currentUser={currentUser}
                  globalEmojis={globalEmojis}
                  initialConversationId={view.conversationId}
                  onOpenProfile={(uid) => setView({ kind: 'profile', userId: uid })}
                  unreadIds={unreadDmIds}
                  onActiveConversationChange={setActiveConversationId}
                  onRead={refreshActivity}
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
                onChanged={refreshActivity}
                navigate={setView}
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
                onOpenReports={() => setView({ kind: 'reports' })}
              />
            )}

            {view.kind === 'post' && (
              <PostDetailView
                postId={view.postId}
                currentUser={currentUser}
                globalEmojis={globalEmojis}
                onOpenProfile={(uid) => setView({ kind: 'profile', userId: uid })}
                onOpenProfileByUsername={openProfileByUsername}
              />
            )}

            {view.kind === 'reports' && currentUser.platform_role === 'platform_admin' && (
              <ReportsAdminView onOpenProfile={(uid) => setView({ kind: 'profile', userId: uid })} />
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
              onClick={() => setShowMobileMenu(true)}
              className={`p-2 rounded-lg ${
                ['server', 'profile', 'settings', 'reports'].includes(view.kind) ? 'text-[#5B7CFA]' : 'text-[#9CA3AF]'
              }`}
              aria-label="Menu, servers and settings"
            >
              <Menu className="w-5 h-5" />
            </button>
          </nav>

          {showMobileMenu && (
            <MobileMenu
              currentUser={currentUser}
              servers={servers}
              navigate={setView}
              onCreateServer={() => setShowCreateServer(true)}
              onClose={() => setShowMobileMenu(false)}
            />
          )}

          {reportTarget && (
            <ReportDialog
              key={reportTarget.id}
              targetType={reportTarget.type}
              targetId={reportTarget.id}
              onClose={() => setReportTarget(null)}
            />
          )}

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
    </AppContext.Provider>
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
