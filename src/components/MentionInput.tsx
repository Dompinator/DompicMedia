import React, { useEffect, useRef, useState } from 'react';
import { Profile } from '../types';
import { getSupabase } from '../lib/supabase';
import { Avatar } from './Avatar';

type Props = Omit<React.InputHTMLAttributes<HTMLInputElement | HTMLTextAreaElement>, 'onChange' | 'value'> & {
  value: string;
  onValueChange: (value: string) => void;
  multiline?: boolean;
  rows?: number;
  inputRef?: React.Ref<HTMLInputElement>;
  /** Classes for the wrapper, e.g. "flex-1". */
  wrapperClassName?: string;
};

/** An input or textarea that suggests usernames while typing "@name". */
export function MentionInput({
  value,
  onValueChange,
  multiline,
  inputRef,
  wrapperClassName = '',
  onKeyDown,
  onBlur,
  ...rest
}: Props) {
  const [query, setQuery] = useState<{ start: number; end: number; text: string } | null>(null);
  const [matches, setMatches] = useState<Profile[]>([]);
  const [selected, setSelected] = useState(0);
  const fieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  const setRefs = (el: HTMLInputElement | HTMLTextAreaElement | null) => {
    fieldRef.current = el;
    if (typeof inputRef === 'function') inputRef(el as HTMLInputElement);
    else if (inputRef) (inputRef as React.MutableRefObject<HTMLInputElement | null>).current = el as HTMLInputElement;
  };

  const detect = (text: string, caret: number) => {
    const found = text.slice(0, caret).match(/(^|[^A-Za-z0-9_])@([A-Za-z0-9_]{1,24})$/);
    setQuery(found ? { start: caret - found[2].length - 1, end: caret, text: found[2].toLowerCase() } : null);
  };

  useEffect(() => {
    if (!query) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const { data } = await getSupabase()
        .from('profiles')
        .select('*')
        .ilike('username', `${query.text.replace(/_/g, '\\_')}%`)
        .limit(5);
      if (!cancelled) {
        setMatches((data || []) as Profile[]);
        setSelected(0);
      }
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query?.text]);

  // Clearing the field (after sending) closes the list.
  useEffect(() => {
    if (!value) setQuery(null);
  }, [value]);

  const pick = (profile: Profile) => {
    if (!query) return;
    const inserted = `@${profile.username} `;
    onValueChange(value.slice(0, query.start) + inserted + value.slice(query.end));
    setQuery(null);
    const caret = query.start + inserted.length;
    window.setTimeout(() => {
      fieldRef.current?.focus();
      fieldRef.current?.setSelectionRange(caret, caret);
    }, 0);
  };

  const open = Boolean(query) && matches.length > 0;
  const Field = (multiline ? 'textarea' : 'input') as React.ElementType;

  return (
    <div className={`relative min-w-0 ${wrapperClassName}`}>
      <Field
        {...rest}
        ref={setRefs}
        value={value}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
          onValueChange(e.target.value);
          detect(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
          if (open) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setSelected((s) => (s + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              pick(matches[selected]);
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setQuery(null);
              return;
            }
          }
          onKeyDown?.(e);
        }}
        onBlur={(e: React.FocusEvent<HTMLInputElement>) => {
          setQuery(null);
          onBlur?.(e);
        }}
      />
      {open && (
        <ul
          className={`absolute left-0 z-40 w-60 max-w-full bg-[#141821] border border-white/10 rounded-xl shadow-xl overflow-hidden ${
            multiline ? 'top-full' : 'bottom-full mb-1'
          }`}
        >
          {matches.map((m, i) => (
            <li key={m.id}>
              <button
                type="button"
                // mousedown fires before the field loses focus
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(m);
                }}
                className={`w-full flex items-center gap-2 p-2 text-left text-xs ${i === selected ? 'bg-white/10' : ''}`}
              >
                <Avatar src={m.avatar_url} name={m.display_name} size="xs" />
                <span className="text-white truncate">{m.display_name}</span>
                <span className="text-[#9CA3AF] truncate">@{m.username}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
