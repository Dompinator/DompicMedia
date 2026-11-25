import React, { useState } from 'react';
import { Check, Copy, Database, KeyRound, Radio, ShieldCheck, X } from 'lucide-react';
import { VesperLogoMark } from './VesperLogo';
import { saveBrowserSupabaseConfig } from '../lib/supabase';

interface SupabaseSetupScreenProps {
  onConnected: () => void;
  onClose: () => void;
}

export function SupabaseSetupScreen({ onConnected, onClose }: SupabaseSetupScreenProps) {
  const [url, setUrl] = useState('');
  const [anonKey, setAnonKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copiedFile, setCopiedFile] = useState<string | null>(null);

  const [connecting, setConnecting] = useState(false);

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setConnecting(true);
    try {
      await saveBrowserSupabaseConfig(url, anonKey);
      onConnected();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid Supabase configuration.');
    } finally {
      setConnecting(false);
    }
  };

  const copyCommand = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedFile(label);
      setTimeout(() => setCopiedFile(null), 2000);
    } catch {
      // ignore clipboard errors
    }
  };

  return (
    <div className="min-h-screen bg-[#0B0D11] text-[#F3F4F6] flex flex-col items-center justify-center px-4 py-12">
      <button
        type="button"
        onClick={onClose}
        aria-label="Back to login"
        title="Back to login"
        className="fixed top-5 right-5 z-50 flex h-12 w-12 items-center justify-center rounded-xl border border-white/25 bg-[#202633] text-white shadow-xl hover:bg-[#34415B] transition-colors"
      >
        <span className="text-3xl leading-none font-semibold" aria-hidden="true">×</span>
      </button>
      <div className="w-full max-w-4xl">
        <div className="flex items-center gap-3 mb-8">
          <VesperLogoMark className="w-10 h-10" />
          <div>
            <h1 className="font-display text-2xl font-bold tracking-tight text-white">
              Connect DompicMEDIA to Supabase
            </h1>
            <p className="text-sm text-[#9CA3AF]">
              Enter your project&apos;s public URL and anon key to initialize Auth, Postgres, Realtime, and Storage.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left: Public Browser Config Form */}
          <form
            onSubmit={handleConnect}
            className="lg:col-span-6 bg-[#12151C] border border-white/10 rounded-2xl p-6 space-y-5"
          >
            <div className="flex items-center gap-2 text-sm font-semibold text-white">
              <KeyRound className="w-4 h-4 text-[#5B7CFA]" />
              <span>Public Client Credentials</span>
            </div>

            <div>
              <label className="block text-xs font-medium text-[#D1D5DB] mb-1.5" htmlFor="sb-url">
                Supabase Project URL
              </label>
              <input
                id="sb-url"
                type="url"
                required
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://your-project-ref.supabase.co"
                className="w-full rounded-lg bg-[#0B0D11] border border-white/10 px-3.5 py-2.5 text-sm text-white placeholder-[#6B7280] focus:outline-none focus:border-[#5B7CFA]"
              />
              <p className="mt-1 text-[11px] text-[#9CA3AF]">
                Found in Supabase Dashboard → Project Settings → Data API (or API).
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-[#D1D5DB] mb-1.5" htmlFor="sb-anon">
                Supabase Public Anon Key
              </label>
              <textarea
                id="sb-anon"
                required
                rows={3}
                value={anonKey}
                onChange={(e) => setAnonKey(e.target.value)}
                placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
                className="w-full rounded-lg bg-[#0B0D11] border border-white/10 px-3.5 py-2.5 text-xs font-mono text-white placeholder-[#6B7280] focus:outline-none focus:border-[#5B7CFA]"
              />
              <p className="mt-1.5 text-xs text-[#9CA3AF]">
                Only public client keys belong here. Never paste your service_role key into browser inputs.
              </p>
            </div>

            {error && (
              <div className="rounded-lg bg-[#EF4444]/10 border border-[#EF4444]/30 px-3.5 py-2.5 text-xs text-[#FCA5A5]">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={connecting}
              className="w-full rounded-lg bg-[#5B7CFA] hover:bg-[#4B6CF0] disabled:opacity-50 text-white text-sm font-semibold py-2.5 px-4 transition-colors whitespace-nowrap"
            >
              {connecting ? 'Connecting...' : 'Connect Supabase Project'}
            </button>
          </form>

          {/* Right: Migrations & Server Secrets Checklist */}
          <div className="lg:col-span-6 bg-[#12151C] border border-white/10 rounded-2xl p-6 space-y-5">
            <div className="flex items-center gap-2 text-sm font-semibold text-white">
              <Database className="w-4 h-4 text-[#5B7CFA]" />
              <span>Backend Setup Checklist</span>
            </div>

            <div className="space-y-4 text-xs text-[#D1D5DB] leading-relaxed">
              <div className="pb-4 border-b border-white/8">
                <div className="font-semibold text-white mb-1">1. Run Database &amp; Storage Migrations</div>
                <p className="text-[#9CA3AF] mb-2">
                  Run both SQL files inside your Supabase Dashboard SQL Editor in order:
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => copyCommand('001', 'supabase/migrations/001_initial_schema.sql')}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#181C25] border border-white/10 hover:border-white/20 text-xs font-mono text-white"
                  >
                    {copiedFile === '001' ? <Check className="w-3.5 h-3.5 text-[#22C55E]" /> : <Copy className="w-3.5 h-3.5 text-[#9CA3AF]" />}
                    001_initial_schema.sql
                  </button>
                  <button
                    type="button"
                    onClick={() => copyCommand('002', 'supabase/migrations/002_storage_and_cron.sql')}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#181C25] border border-white/10 hover:border-white/20 text-xs font-mono text-white"
                  >
                    {copiedFile === '002' ? <Check className="w-3.5 h-3.5 text-[#22C55E]" /> : <Copy className="w-3.5 h-3.5 text-[#9CA3AF]" />}
                    002_storage_and_cron.sql
                  </button>
                </div>
              </div>

              <div className="pb-4 border-b border-white/8">
                <div className="flex items-center gap-1.5 font-semibold text-white mb-1">
                  <ShieldCheck className="w-3.5 h-3.5 text-[#22C55E]" />
                  <span>2. Optional Server Secrets (AI Studio Secrets Panel)</span>
                </div>
                <ul className="space-y-1 text-[#9CA3AF] font-mono text-[11px]">
                  <li>VITE_SUPABASE_URL &amp; VITE_SUPABASE_ANON_KEY</li>
                  <li>SUPABASE_SERVICE_ROLE_KEY (24h attachment cleanup + emoji sync)</li>
                  <li>CRON_SECRET (protects /api/attachments/cleanup)</li>
                </ul>
              </div>

              <div>
                <div className="flex items-center gap-1.5 font-semibold text-white mb-1">
                  <Radio className="w-3.5 h-3.5 text-[#22C55E]" />
                  <span>3. Built-in Voice &amp; Video Calling</span>
                </div>
                <p className="text-[#9CA3AF]">
                  Voice &amp; video channels use direct WebRTC plus an automatic built-in server media relay (<span className="font-mono text-white/90">/ws/voice</span>)—no third-party TURN signup required.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
