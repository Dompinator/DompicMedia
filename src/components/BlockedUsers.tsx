import React, { useEffect, useState } from 'react';
import { Profile } from '../types';
import { getSupabase } from '../lib/supabase';
import { useAppActions } from '../lib/appContext';
import { Avatar } from './Avatar';

export function BlockedUsers() {
  const { blockedIds, setBlocked } = useAppActions();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ids = Array.from(blockedIds);
    if (ids.length === 0) {
      setProfiles([]);
      return;
    }
    getSupabase()
      .from('profiles')
      .select('*')
      .in('id', ids)
      .then(({ data }) => setProfiles((data || []) as Profile[]));
  }, [blockedIds]);

  return (
    <div className="bg-[#12151C] border border-white/8 rounded-2xl p-5 space-y-3">
      <div className="text-sm font-semibold text-white">Blocked accounts</div>
      {error && <p className="text-xs text-[#FCA5A5]">{error}</p>}
      {profiles.length === 0 ? (
        <p className="text-xs text-[#9CA3AF]">You have not blocked anyone.</p>
      ) : (
        profiles.map((p) => (
          <div key={p.id} className="flex items-center gap-3">
            <Avatar src={p.avatar_url} name={p.display_name} size="sm" />
            <span className="flex-1 min-w-0 truncate text-xs text-white">
              {p.display_name} <span className="text-[#9CA3AF]">@{p.username}</span>
            </span>
            <button
              type="button"
              onClick={async () => setError(await setBlocked(p.id, false))}
              className="px-3 py-1.5 rounded-lg bg-[#181C25] border border-white/10 text-xs text-white"
            >
              Unblock
            </button>
          </div>
        ))
      )}
    </div>
  );
}
