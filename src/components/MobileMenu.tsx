import React from 'react';
import { Flag, LogOut, Plus, Settings, User, X } from 'lucide-react';
import { AppView, Profile, Server } from '../types';
import { getSupabase } from '../lib/supabase';
import { Avatar } from './Avatar';

/** Phone-only sheet with everything that lives in the desktop side rail. */
export function MobileMenu({
  currentUser,
  servers,
  navigate,
  onCreateServer,
  onClose,
}: {
  currentUser: Profile;
  servers: Server[];
  navigate: (view: AppView) => void;
  onCreateServer: () => void;
  onClose: () => void;
}) {
  const row = 'w-full flex items-center gap-3 px-3 py-3 rounded-xl text-sm text-left text-[#E5E7EB] hover:bg-white/5';
  const go = (view: AppView) => {
    navigate(view);
    onClose();
  };

  return (
    <div className="md:hidden fixed inset-0 z-40 bg-black/70 flex items-end" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Menu"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-h-[85dvh] overflow-y-auto bg-[#12151C] border-t border-white/10 rounded-t-2xl p-3"
      >
        <div className="flex items-center justify-between px-3 pb-2">
          <span className="font-display text-sm font-bold text-white">Menu</span>
          <button type="button" onClick={onClose} aria-label="Close menu" className="p-1 text-[#9CA3AF]">
            <X className="w-5 h-5" />
          </button>
        </div>
        <button type="button" className={row} onClick={() => go({ kind: 'profile', userId: currentUser.id })}>
          <User className="w-5 h-5" /> Your profile
        </button>
        <button type="button" className={row} onClick={() => go({ kind: 'settings' })}>
          <Settings className="w-5 h-5" /> Settings
        </button>
        {currentUser.platform_role === 'platform_admin' && (
          <button type="button" className={row} onClick={() => go({ kind: 'reports' })}>
            <Flag className="w-5 h-5" /> Reports
          </button>
        )}

        <div className="px-3 pt-3 pb-1 text-[11px] font-semibold text-[#9CA3AF]">Servers</div>
        {servers.map((s) => (
          <button key={s.id} type="button" className={row} onClick={() => go({ kind: 'server', serverId: s.id })}>
            <Avatar src={s.icon_url} name={s.name} size="sm" />
            <span className="truncate">{s.name}</span>
          </button>
        ))}
        <button
          type="button"
          className={row}
          onClick={() => {
            onCreateServer();
            onClose();
          }}
        >
          <Plus className="w-5 h-5" /> Create a server
        </button>

        <div className="border-t border-white/8 mt-2 pt-2">
          <button type="button" className={`${row} !text-[#FCA5A5]`} onClick={() => getSupabase().auth.signOut()}>
            <LogOut className="w-5 h-5" /> Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
