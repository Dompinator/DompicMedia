import React, { useState } from 'react';
import { X } from 'lucide-react';
import { ReportTargetType } from '../types';
import { getSupabase } from '../lib/supabase';

export const REPORT_REASONS: Array<[string, string]> = [
  ['spam', 'Spam or scam'],
  ['harassment', 'Harassment or bullying'],
  ['hate', 'Hate speech'],
  ['sexual', 'Sexual content'],
  ['violence', 'Violence or threats'],
  ['copyright', 'Copyright (stolen music or media)'],
  ['other', 'Something else'],
];

const TARGET_LABEL: Record<ReportTargetType, string> = {
  post: 'post',
  profile: 'account',
  channel_message: 'message',
  dm: 'message',
};

export function ReportDialog({
  targetType,
  targetId,
  onClose,
}: {
  targetType: ReportTargetType;
  targetId: string;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('spam');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: rpcError } = await getSupabase().rpc('report_content', {
      p_target_type: targetType,
      p_target_id: targetId,
      p_reason: reason,
      p_details: details.trim(),
    });
    setBusy(false);
    if (rpcError) setError(rpcError.message);
    else setDone(true);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm bg-[#12151C] border border-white/10 rounded-2xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-base font-bold text-white">Report {TARGET_LABEL[targetType]}</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="text-[#9CA3AF] hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
        {done ? (
          <p className="text-sm text-[#86EFAC]">Thanks. The report was sent to the platform admins.</p>
        ) : (
          <>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-label="Reason"
              className="w-full rounded-lg bg-[#0B0D11] border border-white/10 px-3 py-2 text-sm text-white"
            >
              {REPORT_REASONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <textarea
              rows={3}
              maxLength={500}
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder="Details (optional)"
              className="w-full rounded-lg bg-[#0B0D11] border border-white/10 px-3 py-2 text-sm text-white"
            />
            {error && <p className="text-xs text-[#FCA5A5]">{error}</p>}
            <button
              type="submit"
              disabled={busy}
              className="w-full py-2 rounded-lg bg-[#EF4444] hover:bg-[#DC2626] disabled:opacity-50 text-xs font-semibold text-white"
            >
              {busy ? 'Sending...' : 'Send report'}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
