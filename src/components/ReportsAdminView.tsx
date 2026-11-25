import React, { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Report } from '../types';
import { getSupabase } from '../lib/supabase';
import { formatRelativeTime } from '../lib/utils';
import { REPORT_REASONS } from './ReportDialog';

/** Platform admin queue. The database refuses these actions for everyone else. */
export function ReportsAdminView({ onOpenProfile }: { onOpenProfile: (userId: string) => void }) {
  const [status, setStatus] = useState<Report['status']>('open');
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error: loadError } = await getSupabase()
      .from('reports')
      .select(
        '*, reporter:profiles!reports_reporter_id_fkey(*), reported_user:profiles!reports_reported_user_id_fkey(*)'
      )
      .eq('status', status)
      .order('created_at', { ascending: false })
      .limit(100);
    if (loadError) setError(loadError.message);
    setReports((data || []) as unknown as Report[]);
    setLoading(false);
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (report: Report, action: 'dismiss' | 'resolve' | 'delete_content') => {
    if (action === 'delete_content' && !window.confirm('Permanently delete this content?')) return;
    setBusyId(report.id);
    setError(null);
    const { error: rpcError } = await getSupabase().rpc('resolve_report', {
      p_report_id: report.id,
      p_action: action,
    });
    if (rpcError) setError(rpcError.message);
    await load();
    setBusyId(null);
  };

  const button = 'px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-50';

  return (
    <div className="max-w-3xl mx-auto w-full px-4 py-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/8 pb-4">
        <h2 className="font-display text-lg font-bold text-white">Reports</h2>
        <div className="flex gap-1 p-1 bg-[#12151C] border border-white/8 rounded-lg">
          {(['open', 'resolved', 'dismissed'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(s)}
              className={`px-3 py-1.5 text-xs rounded-md capitalize ${status === s ? 'bg-[#5B7CFA] text-white' : 'text-[#9CA3AF]'}`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="text-xs text-[#FCA5A5]">{error}</p>}

      {loading ? (
        <div className="py-12 flex justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-[#5B7CFA]" />
        </div>
      ) : reports.length === 0 ? (
        <p className="py-12 text-center text-xs text-[#9CA3AF]">No {status} reports.</p>
      ) : (
        reports.map((r) => (
          <article key={r.id} className="bg-[#12151C] border border-white/8 rounded-2xl p-4 space-y-2">
            <div className="flex flex-wrap items-center gap-x-2 text-xs text-[#9CA3AF]">
              <span className="font-semibold text-white">
                {REPORT_REASONS.find(([v]) => v === r.reason)?.[1] || r.reason}
              </span>
              <span>· {r.target_type.replace('_', ' ')}</span>
              <span>· {formatRelativeTime(r.created_at)}</span>
            </div>
            <div className="text-xs text-[#9CA3AF]">
              Against{' '}
              <button type="button" onClick={() => onOpenProfile(r.reported_user_id)} className="text-[#7C96FF] hover:underline">
                @{r.reported_user?.username || 'user'}
              </button>{' '}
              by @{r.reporter?.username || 'user'}
            </div>
            {r.snapshot && (
              <p className="rounded-lg bg-[#0B0D11] border border-white/8 p-3 text-sm text-[#E5E7EB] whitespace-pre-wrap break-words">
                {r.snapshot}
              </p>
            )}
            {r.details && <p className="text-xs text-[#D1D5DB]">Reporter note: {r.details}</p>}
            {r.status === 'open' && (
              <div className="flex flex-wrap gap-2 pt-1">
                <button type="button" disabled={busyId === r.id} onClick={() => act(r, 'dismiss')} className={`${button} bg-[#181C25] text-[#D1D5DB]`}>
                  Dismiss
                </button>
                <button type="button" disabled={busyId === r.id} onClick={() => act(r, 'resolve')} className={`${button} bg-[#5B7CFA] text-white`}>
                  Mark resolved
                </button>
                {r.target_type !== 'profile' && (
                  <button type="button" disabled={busyId === r.id} onClick={() => act(r, 'delete_content')} className={`${button} bg-[#EF4444] text-white`}>
                    Delete content
                  </button>
                )}
              </div>
            )}
          </article>
        ))
      )}
    </div>
  );
}
