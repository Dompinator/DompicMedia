import React, { useEffect, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { GlobalEmoji, Post, Profile } from '../types';
import { getSupabase } from '../lib/supabase';
import { hydratePostRows, POST_SELECT } from '../lib/posts';
import { PostList } from './PostList';

const PAGE = 20;

export function SearchPostsPanel({
  initialQuery,
  currentUser,
  globalEmojis,
  onOpenProfile,
  onOpenProfileByUsername,
}: {
  initialQuery: string;
  currentUser: Profile;
  globalEmojis: GlobalEmoji[];
  onOpenProfile: (userId: string) => void;
  onOpenProfileByUsername: (username: string) => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [posts, setPosts] = useState<Post[]>([]);
  const [limit, setLimit] = useState(PAGE);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = query.trim().length >= 2;

  useEffect(() => setQuery(initialQuery), [initialQuery]);

  useEffect(() => {
    if (!ready) {
      setPosts([]);
      setHasMore(false);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(async () => {
      const { data, error: searchError } = await getSupabase()
        .rpc('search_posts', { p_query: query.trim(), p_limit: Math.min(limit, 50), p_offset: 0 })
        .select(POST_SELECT);
      const rows = (data || []) as unknown[];
      const hydrated = await hydratePostRows(rows, currentUser.id);
      if (cancelled) return;
      setError(searchError ? searchError.message : null);
      setPosts(hydrated);
      setHasMore(rows.length === limit && limit < 50);
      setLoading(false);
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [currentUser.id, limit, query, ready]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2.5 bg-[#12151C] border border-white/10 rounded-xl px-4 py-2.5">
        <Search className="w-4 h-4 text-[#9CA3AF] shrink-0" />
        <input
          type="search"
          value={query}
          maxLength={100}
          onChange={(e) => {
            setQuery(e.target.value);
            setLimit(PAGE);
          }}
          placeholder="Search posts, song titles or #hashtags..."
          className="w-full bg-transparent text-sm text-white placeholder-[#6B7280] focus:outline-none"
        />
        {loading && <Loader2 className="w-4 h-4 animate-spin text-[#5B7CFA]" />}
      </div>
      {error && <p className="text-xs text-[#FCA5A5]">{error}</p>}
      {!ready ? (
        <p className="py-10 text-center text-xs text-[#9CA3AF]">Type at least 2 characters.</p>
      ) : !loading && posts.length === 0 && !error ? (
        <p className="py-10 text-center text-xs text-[#9CA3AF]">No posts match “{query.trim()}”.</p>
      ) : (
        <PostList
          initialPosts={posts}
          currentUser={currentUser}
          globalEmojis={globalEmojis}
          onOpenProfile={onOpenProfile}
          onOpenProfileByUsername={onOpenProfileByUsername}
        />
      )}
      {hasMore && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => setLimit(50)}
            className="px-5 py-2 rounded-lg bg-[#12151C] border border-white/10 text-xs font-semibold text-white"
          >
            Show more
          </button>
        </div>
      )}
    </div>
  );
}
