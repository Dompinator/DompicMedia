import React, { useMemo, useState } from 'react';
import { Search, Smile } from 'lucide-react';
import { GlobalEmoji } from '../types';
import { BUILTIN_EMOJIS } from '../lib/utils';
import { useAppActions } from '../lib/appContext';

export function resolveEmojiUrl(shortcode: string, globalEmojis: GlobalEmoji[]): string | null {
  const clean = shortcode.toLowerCase();
  const match = globalEmojis.find((e) => e.shortcode === clean);
  if (match?.public_url) return match.public_url;
  if ((BUILTIN_EMOJIS as readonly string[]).includes(clean)) {
    return `${import.meta.env.BASE_URL}emojis/${clean}.png`;
  }
  return null;
}

export function CustomEmojiImg({
  shortcode,
  globalEmojis,
  size = 20,
  className = '',
}: {
  shortcode: string;
  globalEmojis: GlobalEmoji[];
  size?: number;
  className?: string;
}) {
  const [errored, setErrored] = useState(false);
  const url = resolveEmojiUrl(shortcode, globalEmojis);

  if (!url || errored) {
    return <span className="font-mono text-xs text-[#9CA3AF]">:{shortcode}:</span>;
  }

  return (
    <img
      src={url}
      alt={`:${shortcode}:`}
      title={`:${shortcode}:`}
      width={size}
      height={size}
      referrerPolicy="no-referrer"
      onError={() => setErrored(true)}
      className={`inline-block align-text-bottom object-contain select-none ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

const EMOJI_TOKEN_RE = /(:[a-z0-9_]{2,32}:)/gi;
const LINK_TOKEN_RE = /(@[A-Za-z0-9_]{3,24}(?![A-Za-z0-9_])|#[\p{L}\p{N}_]+)/gu;

export function RichTextWithEmojis({
  text,
  globalEmojis,
  onMentionClick,
}: {
  text: string;
  globalEmojis: GlobalEmoji[];
  onMentionClick?: (username: string) => void;
}) {
  const parts = useMemo(() => text.split(EMOJI_TOKEN_RE), [text]);
  const actions = useAppActions();
  const openMention = onMentionClick || actions.openProfileByUsername;

  /** Turns @usernames and #hashtags into buttons. Text glued to a word (a@b.com) stays plain. */
  const linkify = (segment: string) => {
    const tokens = segment.split(LINK_TOKEN_RE);
    return tokens.map((token, i) => {
      // Capturing split: odd indexes are the matched tokens.
      const previous = i > 0 ? tokens[i - 1] : '';
      if (i % 2 === 0 || /[\p{L}\p{N}_]$/u.test(previous)) {
        return <React.Fragment key={i}>{token}</React.Fragment>;
      }
      return (
        <button
          key={i}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (token.startsWith('@')) openMention(token.slice(1).toLowerCase());
            else actions.openHashtag(token);
          }}
          className="text-[#7C96FF] hover:underline font-medium"
        >
          {token}
        </button>
      );
    });
  };

  return (
    <span className="whitespace-pre-wrap break-words leading-relaxed">
      {parts.map((part, idx) => {
        if (part.startsWith(':') && part.endsWith(':') && part.length >= 4) {
          const code = part.slice(1, -1).toLowerCase();
          const url = resolveEmojiUrl(code, globalEmojis);
          if (url) {
            return (
              <CustomEmojiImg
                key={`${idx}-${code}`}
                shortcode={code}
                globalEmojis={globalEmojis}
                size={20}
                className="mx-0.5"
              />
            );
          }
        }
        return <React.Fragment key={idx}>{linkify(part)}</React.Fragment>;
      })}
    </span>
  );
}

export function EmojiPicker({
  globalEmojis,
  onSelect,
  onClose,
}: {
  globalEmojis: GlobalEmoji[];
  onSelect: (shortcode: string) => void;
  onClose?: () => void;
}) {
  const [query, setQuery] = useState('');

  const allShortcodes = useMemo(() => {
    const map = new Map<string, { shortcode: string; label: string; url: string }>();
    for (const code of BUILTIN_EMOJIS) {
      map.set(code, { shortcode: code, label: code, url: `${import.meta.env.BASE_URL}emojis/${code}.png` });
    }
    for (const ge of globalEmojis) {
      map.set(ge.shortcode, {
        shortcode: ge.shortcode,
        label: ge.label,
        url: ge.public_url,
      });
    }
    const items = Array.from(map.values());
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) => i.shortcode.includes(q) || i.label.toLowerCase().includes(q)
    );
  }, [globalEmojis, query]);

  return (
    <div className="w-72 bg-[#141821] border border-white/10 rounded-xl shadow-2xl p-3 z-40">
      <div className="flex items-center gap-2 bg-[#0B0D11] border border-white/10 rounded-lg px-2.5 py-1.5 mb-2.5">
        <Search className="w-3.5 h-3.5 text-[#9CA3AF] shrink-0" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search platform emojis..."
          className="w-full bg-transparent text-xs text-white placeholder-[#6B7280] focus:outline-none"
          autoFocus
        />
      </div>

      {allShortcodes.length === 0 ? (
        <div className="py-6 text-center text-xs text-[#6B7280]">
          <Smile className="w-5 h-5 mx-auto mb-1 opacity-60" />
          No matching custom emojis
        </div>
      ) : (
        <div className="grid grid-cols-6 gap-1.5 max-h-48 overflow-y-auto pr-0.5">
          {allShortcodes.map((emoji) => (
            <button
              key={emoji.shortcode}
              type="button"
              title={`:${emoji.shortcode}:`}
              onClick={() => {
                onSelect(emoji.shortcode);
                onClose?.();
              }}
              className="w-10 h-10 rounded-lg flex items-center justify-center hover:bg-white/10 transition-colors focus-visible:outline-2 focus-visible:outline-[#5B7CFA]"
            >
              <img
                src={emoji.url}
                alt={`:${emoji.shortcode}:`}
                width={26}
                height={26}
                referrerPolicy="no-referrer"
                className="w-6.5 h-6.5 object-contain"
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
