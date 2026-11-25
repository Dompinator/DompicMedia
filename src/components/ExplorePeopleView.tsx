import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, Search, Shield, Smile, Trash2, Upload, UserMinus, Users } from 'lucide-react';
import { GlobalEmoji, Profile } from '../types';
import { getSupabase } from '../lib/supabase';
import { BUILTIN_EMOJIS, validatePng128x128 } from '../lib/utils';
import { Avatar } from './Avatar';

interface ExplorePeopleViewProps {
  currentUser: Profile;
  globalEmojis: GlobalEmoji[];
  onOpenProfile: (userId: string) => void;
  onRefreshEmojis: () => Promise<void>;
}

export function ExplorePeopleView({
  currentUser,
  globalEmojis,
  onOpenProfile,
  onRefreshEmojis,
}: ExplorePeopleViewProps) {
  const [tab, setTab] = useState<'search' | 'friends' | 'following' | 'followers' | 'emojis'>('search');
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(false);

  // Admin Emoji Studio state
  const [newShortcode, setNewShortcode] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [emojiFile, setEmojiFile] = useState<File | null>(null);
  const [emojiMsg, setEmojiMsg] = useState<string | null>(null);
  const [emojiErr, setEmojiErr] = useState<string | null>(null);
  const [uploadingEmoji, setUploadingEmoji] = useState(false);

  const loadPeople = useCallback(async () => {
    setLoading(true);
    try {
      const supabase = getSupabase();
      if (tab === 'search') {
        const clean = query.trim().toLowerCase().replace(/^@/, '');
        let q = supabase.from('profiles').select('*').neq('id', currentUser.id).limit(30);
        if (clean) {
          q = q.or(`username.ilike.%${clean}%,display_name.ilike.%${clean}%`);
        } else {
          q = q.order('created_at', { ascending: false });
        }
        const { data } = await q;
        setPeople((data || []) as Profile[]);
      } else if (tab === 'friends') {
        const { data } = await supabase
          .from('friendships')
          .select('user_a, user_b')
          .or(`user_a.eq.${currentUser.id},user_b.eq.${currentUser.id}`);
        const ids = (data || []).map((f) =>
          f.user_a === currentUser.id ? (f.user_b as string) : (f.user_a as string)
        );
        if (ids.length === 0) {
          setPeople([]);
        } else {
          const { data: profs } = await supabase.from('profiles').select('*').in('id', ids);
          setPeople((profs || []) as Profile[]);
        }
      } else if (tab === 'following') {
        const { data } = await supabase
          .from('follows')
          .select('following:profiles!follows_following_id_fkey(*)')
          .eq('follower_id', currentUser.id);
        setPeople((data || []).map((r) => r.following as unknown as Profile).filter(Boolean));
      } else if (tab === 'followers') {
        const { data } = await supabase
          .from('follows')
          .select('follower:profiles!follows_follower_id_fkey(*)')
          .eq('following_id', currentUser.id);
        setPeople((data || []).map((r) => r.follower as unknown as Profile).filter(Boolean));
      }
    } finally {
      setLoading(false);
    }
  }, [currentUser.id, query, tab]);

  useEffect(() => {
    if (tab !== 'emojis') {
      const t = setTimeout(loadPeople, tab === 'search' ? 200 : 0);
      return () => clearTimeout(t);
    }
  }, [loadPeople, tab]);

  const removeFriend = async (otherId: string) => {
    const supabase = getSupabase();
    const uA = currentUser.id < otherId ? currentUser.id : otherId;
    const uB = currentUser.id < otherId ? otherId : currentUser.id;
    await supabase.from('friendships').delete().eq('user_a', uA).eq('user_b', uB);
    setPeople((prev) => prev.filter((p) => p.id !== otherId));
  };

  const handleEmojiFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setEmojiErr(null);
    const file = e.target.files?.[0];
    if (!file) return;
    const err = await validatePng128x128(file);
    if (err) {
      setEmojiErr(err);
      setEmojiFile(null);
      return;
    }
    setEmojiFile(file);
  };

  const handleUploadGlobalEmoji = async (e: React.FormEvent) => {
    e.preventDefault();
    if (currentUser.platform_role !== 'platform_admin' || !emojiFile) return;
    setEmojiErr(null);
    setEmojiMsg(null);
    const code = newShortcode.trim().toLowerCase();
    if (!/^[a-z0-9_]{2,32}$/.test(code)) {
      setEmojiErr('Shortcode must be 2–32 lowercase letters, numbers, or underscores.');
      return;
    }
    setUploadingEmoji(true);
    try {
      const supabase = getSupabase();
      const storagePath = `global/${code}.png`;
      const { error: upErr } = await supabase.storage
        .from('emojis')
        .upload(storagePath, emojiFile, { contentType: 'image/png', upsert: true });
      if (upErr) throw upErr;

      const { data: pub } = supabase.storage.from('emojis').getPublicUrl(storagePath);
      const { error: insErr } = await supabase.from('global_emojis').upsert(
        {
          shortcode: code,
          label: newLabel.trim() || code,
          storage_path: storagePath,
          public_url: pub.publicUrl,
          width: 128,
          height: 128,
          created_by: currentUser.id,
        },
        { onConflict: 'shortcode' }
      );
      if (insErr) throw insErr;

      await onRefreshEmojis();
      setNewShortcode('');
      setNewLabel('');
      setEmojiFile(null);
      setEmojiMsg(`:${code}: uploaded and available globally.`);
    } catch (err) {
      setEmojiErr(err instanceof Error ? err.message : 'Failed to upload emoji.');
    } finally {
      setUploadingEmoji(false);
    }
  };

  const handleSeedBuiltins = async () => {
    setEmojiErr(null);
    setEmojiMsg(null);
    setUploadingEmoji(true);
    try {
      const supabase = getSupabase();
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      const res = await fetch('/api/emojis/seed', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to sync default emojis');
      await onRefreshEmojis();
      setEmojiMsg(`Synced ${json.count} 128x128 transparent PNG emojis to Supabase Storage.`);
    } catch (err) {
      setEmojiErr(err instanceof Error ? err.message : 'Sync failed.');
    } finally {
      setUploadingEmoji(false);
    }
  };

  const handleDeleteEmoji = async (emoji: GlobalEmoji) => {
    const supabase = getSupabase();
    await supabase.storage.from('emojis').remove([emoji.storage_path]);
    await supabase.from('global_emojis').delete().eq('id', emoji.id);
    await onRefreshEmojis();
  };

  return (
    <div className="max-w-3xl mx-auto w-full px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/8 pb-4 mb-5">
        <h2 className="font-display text-lg font-bold text-white">People &amp; Platform Emojis</h2>
        <div className="flex flex-wrap items-center gap-1 p-1 bg-[#12151C] border border-white/8 rounded-lg">
          {(['search', 'friends', 'following', 'followers', 'emojis'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md capitalize transition-colors whitespace-nowrap ${
                tab === t ? 'bg-[#5B7CFA] text-white' : 'text-[#9CA3AF] hover:text-white'
              }`}
            >
              {t === 'emojis' ? 'Emoji Library' : t}
            </button>
          ))}
        </div>
      </div>

      {tab === 'search' && (
        <div className="flex items-center gap-2.5 bg-[#12151C] border border-white/10 rounded-xl px-4 py-2.5 mb-5">
          <Search className="w-4 h-4 text-[#9CA3AF] shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by @username or display name..."
            className="w-full bg-transparent text-sm text-white placeholder-[#6B7280] focus:outline-none"
          />
        </div>
      )}

      {tab === 'emojis' ? (
        <div className="space-y-6">
          <div className="bg-[#12151C] border border-white/8 rounded-2xl p-5">
            <div className="flex items-center justify-between gap-3 mb-4">
              <div>
                <h3 className="font-display text-sm font-semibold text-white flex items-center gap-2">
                  <Smile className="w-4 h-4 text-[#5B7CFA]" />
                  <span>Custom 128×128 Transparent PNG Library</span>
                </h3>
                <p className="text-xs text-[#9CA3AF] mt-0.5">
                  Shared across all posts, replies, DMs, server channels, and message reactions.
                </p>
              </div>
              {currentUser.platform_role === 'platform_admin' && (
                <button
                  type="button"
                  disabled={uploadingEmoji}
                  onClick={handleSeedBuiltins}
                  className="px-3.5 py-2 rounded-lg bg-[#181C25] border border-white/10 hover:border-white/25 text-xs font-semibold text-white whitespace-nowrap"
                >
                  Sync Built-in Set to Storage
                </button>
              )}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {(globalEmojis.length > 0
                ? globalEmojis.map((g) => ({
                    id: g.id,
                    shortcode: g.shortcode,
                    url: g.public_url,
                    raw: g as GlobalEmoji | null,
                  }))
                : BUILTIN_EMOJIS.map((code) => ({
                    id: code,
                    shortcode: code,
                    url: `/emojis/${code}.png`,
                    raw: null as GlobalEmoji | null,
                  }))
              ).map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-2 p-2.5 rounded-xl bg-[#0B0D11] border border-white/8"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <img
                      src={item.url}
                      alt={`:${item.shortcode}:`}
                      width={32}
                      height={32}
                      referrerPolicy="no-referrer"
                      className="w-8 h-8 object-contain shrink-0"
                    />
                    <span className="font-mono text-xs text-[#E5E7EB] truncate">
                      :{item.shortcode}:
                    </span>
                  </div>
                  {item.raw && currentUser.platform_role === 'platform_admin' && (
                    <button
                      type="button"
                      onClick={() => handleDeleteEmoji(item.raw!)}
                      className="p-1 text-[#6B7280] hover:text-[#EF4444]"
                      title="Delete global emoji"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {currentUser.platform_role === 'platform_admin' ? (
            <form
              onSubmit={handleUploadGlobalEmoji}
              className="bg-[#12151C] border border-white/8 rounded-2xl p-5 space-y-4"
            >
              <div className="flex items-center gap-2 text-sm font-semibold text-white">
                <Shield className="w-4 h-4 text-[#22C55E]" />
                <span>Admin Emoji Upload (128×128 Transparent PNG)</span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[#D1D5DB] mb-1">Shortcode</label>
                  <input
                    type="text"
                    required
                    value={newShortcode}
                    onChange={(e) => setNewShortcode(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                    placeholder="e.g. hype"
                    className="w-full rounded-lg bg-[#0B0D11] border border-white/10 px-3 py-2 text-xs font-mono text-white"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#D1D5DB] mb-1">Label</label>
                  <input
                    type="text"
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                    placeholder="Hype"
                    className="w-full rounded-lg bg-[#0B0D11] border border-white/10 px-3 py-2 text-xs text-white"
                  />
                </div>
              </div>

              <div>
                <label className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#0B0D11] border border-white/10 hover:border-white/25 text-xs text-white cursor-pointer">
                  <Upload className="w-3.5 h-3.5 text-[#5B7CFA]" />
                  <span>{emojiFile ? emojiFile.name : 'Choose 128×128 PNG file'}</span>
                  <input type="file" accept="image/png" onChange={handleEmojiFileChange} className="hidden" />
                </label>
              </div>

              {emojiErr && <p className="text-xs text-[#FCA5A5]">{emojiErr}</p>}
              {emojiMsg && <p className="text-xs text-[#86EFAC]">{emojiMsg}</p>}

              <button
                type="submit"
                disabled={uploadingEmoji || !emojiFile}
                className="px-4 py-2 rounded-lg bg-[#5B7CFA] hover:bg-[#4B6CF0] disabled:opacity-40 text-xs font-semibold text-white"
              >
                {uploadingEmoji ? 'Uploading...' : 'Publish Global Emoji'}
              </button>
            </form>
          ) : (
            <p className="text-xs text-[#9CA3AF]">
              Only website administrators (<span className="font-mono">platform_admin</span>) can add or remove global platform emojis.
            </p>
          )}
        </div>
      ) : loading ? (
        <div className="py-12 flex justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-[#5B7CFA]" />
        </div>
      ) : people.length === 0 ? (
        <div className="bg-[#12151C] border border-white/8 rounded-2xl py-12 text-center">
          <Users className="w-6 h-6 text-[#6B7280] mx-auto mb-2" />
          <p className="text-xs text-[#9CA3AF]">No accounts found in this view.</p>
        </div>
      ) : (
        <div className="divide-y divide-white/8 bg-[#12151C] border border-white/8 rounded-2xl overflow-hidden">
          {people.map((person) => (
            <div key={person.id} className="flex items-center justify-between gap-4 p-4">
              <button
                type="button"
                onClick={() => onOpenProfile(person.id)}
                className="flex items-center gap-3 min-w-0 text-left"
              >
                <Avatar src={person.avatar_url} name={person.display_name} size="md" />
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-white truncate hover:underline">
                    {person.display_name}
                  </div>
                  <div className="text-xs text-[#9CA3AF] truncate">@{person.username}</div>
                </div>
              </button>

              <div className="flex items-center gap-2 shrink-0">
                {tab === 'friends' && (
                  <button
                    type="button"
                    onClick={() => removeFriend(person.id)}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[#181C25] border border-white/10 hover:border-[#EF4444]/40 text-xs text-[#D1D5DB] hover:text-[#FCA5A5]"
                  >
                    <UserMinus className="w-3.5 h-3.5" />
                    <span>Remove</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onOpenProfile(person.id)}
                  className="px-3 py-1.5 rounded-lg bg-[#181C25] border border-white/10 hover:border-white/25 text-xs font-medium text-white"
                >
                  View Profile
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
