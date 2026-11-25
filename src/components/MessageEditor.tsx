import React, { useState } from 'react';
import { getSupabase } from '../lib/supabase';

/** Inline editor for one channel message or DM. Enter saves, Escape cancels. */
export function MessageEditor({
  table,
  messageId,
  initial,
  onSaved,
  onCancel,
}: {
  table: 'channel_messages' | 'direct_messages';
  messageId: string;
  initial: string;
  onSaved: (content: string, editedAt: string | null) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const content = value.trim();
    if (content === initial.trim()) {
      onCancel();
      return;
    }
    setSaving(true);
    setError(null);
    const { data, error: updateError } = await getSupabase()
      .from(table)
      .update({ content })
      .eq('id', messageId)
      .select('content, edited_at')
      .single();
    setSaving(false);
    if (updateError) setError(updateError.message);
    else onSaved(data.content as string, data.edited_at as string | null);
  };

  return (
    <form onSubmit={save} className="mt-1 space-y-1.5">
      <input
        type="text"
        autoFocus
        value={value}
        maxLength={4000}
        aria-label="Edit message"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
        className="w-full rounded-lg bg-[#12151C] border border-[#5B7CFA]/60 px-3 py-2 text-sm text-white focus:outline-none"
      />
      <div className="flex items-center gap-2 text-[11px]">
        <button type="submit" disabled={saving} className="px-2.5 py-1 rounded-full bg-[#5B7CFA] text-white font-semibold">
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button type="button" onClick={onCancel} className="px-2.5 py-1 text-[#9CA3AF] hover:text-white">
          Cancel
        </button>
        {error && <span className="text-[#FCA5A5]">{error}</span>}
      </div>
    </form>
  );
}
