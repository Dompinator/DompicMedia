import React, { useEffect, useState } from 'react';
import { Bell, Flag, LogOut, RefreshCw, Shield, Volume2, VolumeX } from 'lucide-react';
import { Profile } from '../types';
import { clearBrowserSupabaseConfig, getSupabase } from '../lib/supabase';
import { getSoundPreference, setSoundPreference } from '../lib/utils';
import {
  browserNotificationsEnabled,
  disableBrowserNotifications,
  enableBrowserNotifications,
} from '../lib/browserNotifications';
import { BlockedUsers } from './BlockedUsers';

interface SettingsViewProps {
  currentUser: Profile;
  onSignedOut: () => void;
  onResetConnection: () => void;
  onOpenReports: () => void;
}

export function SettingsView({
  currentUser,
  onSignedOut,
  onResetConnection,
  onOpenReports,
}: SettingsViewProps) {
  const [notificationsOn, setNotificationsOn] = useState(browserNotificationsEnabled());
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const toggleNotifications = async () => {
    setNotificationError(null);
    if (notificationsOn) {
      disableBrowserNotifications();
      setNotificationsOn(false);
      return;
    }
    const message = await enableBrowserNotifications();
    setNotificationError(message);
    setNotificationsOn(!message);
  };
  const [soundEnabled, setSoundEnabled] = useState(getSoundPreference());
  const [health, setHealth] = useState<{
    supabaseConfigured: boolean;
    serviceRoleConfigured: boolean;
    turnConfigured: boolean;
  } | null>(null);
  const [cleanupResult, setCleanupResult] = useState<string | null>(null);
  const [cleaning, setCleaning] = useState(false);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}api/health`)
      .then((r) => {
        const isJson = r.headers.get('content-type')?.includes('application/json');
        if (!r.ok || !isJson) return null;
        return r.json();
      })
      .then((data) => {
        if (data) setHealth(data);
      })
      .catch(() => {});
  }, []);

  const toggleSound = () => {
    const next = !soundEnabled;
    setSoundEnabled(next);
    setSoundPreference(next);
  };

  const runManualCleanup = async () => {
    setCleaning(true);
    setCleanupResult(null);
    try {
      const supabase = getSupabase();
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      const res = await fetch('/api/attachments/cleanup', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Cleanup failed');
      setCleanupResult(
        data.skippedReason
          ? `Skipped: ${data.skippedReason}`
          : `Checked ${data.checked} expired rows, deleted ${data.deleted} objects.`
      );
    } catch (err) {
      setCleanupResult(err instanceof Error ? err.message : 'Cleanup request failed.');
    } finally {
      setCleaning(false);
    }
  };

  const handleSignOut = async () => {
    await getSupabase().auth.signOut();
    onSignedOut();
  };

  return (
    <div className="max-w-2xl mx-auto w-full px-4 py-6 space-y-6">
      <div className="border-b border-white/8 pb-4">
        <h2 className="font-display text-lg font-bold text-white">Settings &amp; Preferences</h2>
      </div>

      {/* Audio Preference */}
      <div className="bg-[#12151C] border border-white/8 rounded-2xl p-5 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          {soundEnabled ? (
            <Volume2 className="w-5 h-5 text-[#5B7CFA]" />
          ) : (
            <VolumeX className="w-5 h-5 text-[#9CA3AF]" />
          )}
          <div>
            <div className="text-sm font-semibold text-white">Startup Intro Chime</div>
            <div className="text-xs text-[#9CA3AF]">
              Play the brief audio chime during the 2-second startup animation when browser permissions allow.
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={toggleSound}
          className={`px-4 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
            soundEnabled
              ? 'bg-[#5B7CFA] text-white'
              : 'bg-[#181C25] border border-white/10 text-[#D1D5DB]'
          }`}
        >
          {soundEnabled ? 'Enabled' : 'Muted'}
        </button>
      </div>

      {/* Browser notifications */}
      <div className="bg-[#12151C] border border-white/8 rounded-2xl p-5 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Bell className={`w-5 h-5 shrink-0 ${notificationsOn ? 'text-[#5B7CFA]' : 'text-[#9CA3AF]'}`} />
          <div>
            <div className="text-sm font-semibold text-white">Browser Notifications</div>
            <div className="text-xs text-[#9CA3AF]">
              Alerts for new DMs and mentions while DompicMEDIA is open in a tab.
            </div>
            {notificationError && <div className="text-xs text-[#FCA5A5] mt-1">{notificationError}</div>}
          </div>
        </div>
        <button
          type="button"
          onClick={toggleNotifications}
          className={`px-4 py-2 rounded-lg text-xs font-semibold whitespace-nowrap ${
            notificationsOn ? 'bg-[#5B7CFA] text-white' : 'bg-[#181C25] border border-white/10 text-[#D1D5DB]'
          }`}
        >
          {notificationsOn ? 'Enabled' : 'Enable'}
        </button>
      </div>

      <BlockedUsers />

      {currentUser.platform_role === 'platform_admin' && (
        <button
          type="button"
          onClick={onOpenReports}
          className="w-full bg-[#12151C] border border-white/8 hover:border-white/20 rounded-2xl p-5 flex items-center gap-3 text-sm font-semibold text-white"
        >
          <Flag className="w-5 h-5 text-[#EF4444]" /> Review reports
        </button>
      )}

      {/* Infrastructure Status */}
      {health && (
        <div className="bg-[#12151C] border border-white/8 rounded-2xl p-5 space-y-3">
          <div className="text-sm font-semibold text-white">Backend Infrastructure</div>
          <div className="space-y-2 text-xs text-[#D1D5DB]">
            <div className="flex items-center justify-between">
              <span className="text-[#9CA3AF]">Service Role (24h Attachment Cleanup)</span>
              <span className={health.serviceRoleConfigured ? 'text-[#22C55E]' : 'text-[#F59E0B]'}>
                {health.serviceRoleConfigured ? 'Configured' : 'Not Configured'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[#9CA3AF]">Voice &amp; Video Transport</span>
              <span className="text-[#22C55E]">
                {health.turnConfigured ? 'WebRTC + TURN + Server Relay' : 'WebRTC + Built-in Server Relay'}
              </span>
            </div>
          </div>

          {currentUser.platform_role === 'platform_admin' && (
            <div className="pt-3 border-t border-white/8 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs text-[#D1D5DB]">
                <Shield className="w-4 h-4 text-[#22C55E]" />
                <span>Admin: Run 24h Attachment Expiration Sweep</span>
              </div>
              <button
                type="button"
                disabled={cleaning}
                onClick={runManualCleanup}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#181C25] border border-white/10 text-xs font-medium text-white"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${cleaning ? 'animate-spin' : ''}`} />
                <span>Run Sweep</span>
              </button>
            </div>
          )}
          {cleanupResult && <p className="text-xs text-[#9CA3AF] font-mono">{cleanupResult}</p>}
        </div>
      )}

      {/* Account Actions */}
      <div className="bg-[#12151C] border border-white/8 rounded-2xl p-5 flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => {
            clearBrowserSupabaseConfig();
            onResetConnection();
          }}
          className="px-4 py-2 rounded-lg bg-[#181C25] border border-white/10 hover:border-white/25 text-xs font-medium text-[#D1D5DB]"
        >
          Change Supabase Project
        </button>

        <button
          type="button"
          onClick={handleSignOut}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#EF4444]/15 border border-[#EF4444]/30 hover:bg-[#EF4444]/25 text-xs font-semibold text-[#FCA5A5]"
        >
          <LogOut className="w-4 h-4" />
          <span>Sign Out</span>
        </button>
      </div>
    </div>
  );
}
