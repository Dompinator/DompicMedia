import React, { useState } from 'react';
import { getSupabase } from '../lib/supabase';

/** Shown after opening a password reset link. */
export function ResetPasswordView({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    const { error: updateError } = await getSupabase().auth.updateUser({ password });
    setBusy(false);
    if (updateError) setError(updateError.message);
    else onDone();
  };

  const field = 'w-full rounded-xl bg-[#0B0D11] border border-white/10 px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-[#5B7CFA]';

  return (
    <div className="min-h-screen bg-[#0B0D11] text-[#F3F4F6] flex items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm bg-[#12151C] border border-white/10 rounded-2xl p-6 space-y-4">
        <h1 className="font-display text-lg font-bold text-white">Choose a new password</h1>
        <input type="password" required minLength={6} autoComplete="new-password" placeholder="New password" value={password} onChange={(e) => setPassword(e.target.value)} className={field} />
        <input type="password" required minLength={6} autoComplete="new-password" placeholder="Repeat new password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={field} />
        {error && <p className="text-xs text-[#FCA5A5]">{error}</p>}
        <button type="submit" disabled={busy} className="w-full py-2.5 rounded-xl bg-[#5B7CFA] hover:bg-[#4B6CF0] disabled:opacity-50 text-sm font-semibold text-white">
          {busy ? 'Saving...' : 'Save password'}
        </button>
        <button type="button" onClick={onDone} className="w-full text-xs text-[#9CA3AF] hover:text-white">
          Skip for now
        </button>
      </form>
    </div>
  );
}
