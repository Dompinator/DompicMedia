import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  MessageSquare,
  Radio,
  Settings2,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { authLinkError, getSupabase } from '../lib/supabase';
import { validateUsername } from '../lib/utils';
import { VesperLogoMark } from './VesperLogo';

interface AuthViewProps {
  onOpenSetup: () => void;
}

const EASE = [0.16, 1, 0.3, 1] as const;

export function AuthView({ onOpenSetup }: AuthViewProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [usernameStatus, setUsernameStatus] = useState<
    'idle' | 'checking' | 'available' | 'taken' | 'invalid'
  >('idle');
  const [usernameHint, setUsernameHint] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(authLinkError);
  const [notice, setNotice] = useState<string | null>(null);

  // Live debounced @username availability check during sign-up
  useEffect(() => {
    if (mode !== 'register') return;
    if (!username.trim()) {
      setUsernameStatus('idle');
      setUsernameHint(null);
      return;
    }

    const check = validateUsername(username);
    if (!check.valid) {
      setUsernameStatus('invalid');
      setUsernameHint(check.error || 'Invalid username.');
      return;
    }

    setUsernameStatus('checking');
    setUsernameHint(null);
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const { data } = await getSupabase()
          .from('profiles')
          .select('id')
          .eq('username', check.normalized)
          .maybeSingle();
        if (cancelled) return;
        if (data) {
          setUsernameStatus('taken');
          setUsernameHint(`@${check.normalized} is already taken.`);
        } else {
          setUsernameStatus('available');
          setUsernameHint(`@${check.normalized} is available`);
        }
      } catch {
        if (!cancelled) setUsernameStatus('idle');
      }
    }, 320);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [mode, username]);

  const handleForgotPassword = async () => {
    setError(null);
    setNotice(null);
    if (!email.trim()) {
      setError('Type your email address first, then press "Forgot password?".');
      return;
    }
    setLoading(true);
    const { error: resetError } = await getSupabase().auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}${import.meta.env.BASE_URL}`,
    });
    setLoading(false);
    if (resetError) setError(resetError.message);
    else setNotice('If an account exists for that address, a reset link is on its way.');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setLoading(true);

    try {
      const supabase = getSupabase();

      if (mode === 'login') {
        const { error: signInErr } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (signInErr) throw signInErr;
      } else {
        const check = validateUsername(username);
        if (!check.valid) {
          throw new Error(check.error || 'Invalid username.');
        }
        const cleanDisplay = displayName.trim() || check.normalized;

        const { data: existing, error: lookupErr } = await supabase
          .from('profiles')
          .select('id')
          .eq('username', check.normalized)
          .maybeSingle();

        if (lookupErr) {
          if (/failed to fetch|load failed|networkerror/i.test(lookupErr.message)) {
            throw new Error(lookupErr.message);
          }
          if (/relation .*profiles.* does not exist/i.test(lookupErr.message)) {
            throw new Error(
              'The profiles table does not exist yet. Run supabase/migrations/001_initial_schema.sql in your Supabase SQL Editor first.'
            );
          }
        }

        if (existing) {
          throw new Error(`@${check.normalized} is already taken. Please choose another username.`);
        }

        const { data, error: signUpErr } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            data: {
              username: check.normalized,
              display_name: cleanDisplay,
            },
          },
        });
        if (signUpErr) throw signUpErr;

        if (!data.session) {
          setNotice('Account created. Check your email to confirm your address, then sign in.');
          setMode('login');
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Authentication failed.';
      if (/failed to fetch|load failed|networkerror/i.test(msg)) {
        setError(
          'Could not reach your Supabase project (network/URL error). Verify your https://<project-ref>.supabase.co URL and ensure your project is active.'
        );
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0B0D11] text-[#F3F4F6] flex items-center justify-center px-4 py-10 relative overflow-hidden">
      {/* Subtle atmospheric glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(91,124,250,0.12),transparent_55%)]"
      />

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: EASE }}
        className="w-full max-w-5xl grid grid-cols-1 lg:grid-cols-12 gap-10 items-center relative z-10"
      >
        {/* Left Brand Showcase */}
        <div className="lg:col-span-6 space-y-8 px-2">
          <div className="flex items-center gap-3.5">
            <VesperLogoMark className="w-11 h-11" />
            <div>
              <span className="font-display text-2xl font-bold tracking-tight text-white">
                DompicMEDIA
              </span>
              <p className="text-xs text-[#9CA3AF]">Unified Social &amp; Community Platform</p>
            </div>
          </div>

          <div className="space-y-3">
            <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight text-white text-balance leading-[1.15]">
              Your social feed, private messages, and community servers in one place.
            </h1>
            <p className="text-sm sm:text-base text-[#9CA3AF] leading-relaxed max-w-lg">
              Follow creators, share media posts, talk in persistent voice and video rooms, and stay connected with real-time messaging.
            </p>
          </div>

          <div className="space-y-4 pt-2 border-t border-white/8 max-w-md">
            <div className="flex items-start gap-3">
              <MessageSquare className="w-4 h-4 text-[#5B7CFA] mt-0.5 shrink-0" />
              <div>
                <div className="text-sm font-semibold text-white">Real-Time Feed &amp; Direct Messages</div>
                <p className="text-xs text-[#9CA3AF]">
                  Instant posts, replies, reposts, and private one-to-one conversations with 24-hour expiring attachments.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <Radio className="w-4 h-4 text-[#22C55E] mt-0.5 shrink-0" />
              <div>
                <div className="text-sm font-semibold text-white">Community Servers &amp; Live Rooms</div>
                <p className="text-xs text-[#9CA3AF]">
                  Create servers with text channels and always-available voice and video rooms with built-in media relay.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <Sparkles className="w-4 h-4 text-[#F59E0B] mt-0.5 shrink-0" />
              <div>
                <div className="text-sm font-semibold text-white">Custom 128×128 Platform Emojis</div>
                <p className="text-xs text-[#9CA3AF]">
                  Consistent custom PNG emoji artwork shared across every post, message, and reaction.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Right Smooth Auth Card */}
        <div className="lg:col-span-6 w-full max-w-md mx-auto lg:ml-auto">
          <div className="bg-[#12151C] border border-white/10 rounded-2xl p-6 sm:p-7 shadow-2xl shadow-black/40">
            <div className="flex items-center justify-between mb-6">
              <div className="relative flex-1 grid grid-cols-2 p-1 bg-[#0B0D11] border border-white/8 rounded-xl mr-3">
                <button
                  type="button"
                  onClick={() => {
                    setMode('login');
                    setError(null);
                  }}
                  className={`relative z-10 py-2 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap ${
                    mode === 'login' ? 'text-white' : 'text-[#9CA3AF] hover:text-white'
                  }`}
                >
                  {mode === 'login' && (
                    <motion.span
                      layoutId="auth-tab-pill"
                      transition={{ duration: 0.22, ease: EASE }}
                      className="absolute inset-0 bg-[#1E2436] rounded-lg -z-10"
                    />
                  )}
                  Sign In
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMode('register');
                    setError(null);
                  }}
                  className={`relative z-10 py-2 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap ${
                    mode === 'register' ? 'text-white' : 'text-[#9CA3AF] hover:text-white'
                  }`}
                >
                  {mode === 'register' && (
                    <motion.span
                      layoutId="auth-tab-pill"
                      transition={{ duration: 0.22, ease: EASE }}
                      className="absolute inset-0 bg-[#1E2436] rounded-lg -z-10"
                    />
                  )}
                  Create Account
                </button>
              </div>

              <button
                type="button"
                onClick={onOpenSetup}
                title="Supabase connection settings"
                className="p-2 rounded-xl text-[#9CA3AF] hover:text-white hover:bg-white/5 border border-transparent hover:border-white/10 transition-colors"
              >
                <Settings2 className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <AnimatePresence mode="popLayout" initial={false}>
                {mode === 'register' && (
                  <motion.div
                    key="register-fields"
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.2, ease: EASE }}
                    className="space-y-4"
                  >
                    <div>
                      <label htmlFor="auth-username" className="block text-xs font-medium text-[#D1D5DB] mb-1.5">
                        Username
                      </label>
                      <div
                        className={`flex items-center rounded-xl bg-[#0B0D11] border px-3.5 transition-colors ${
                          usernameStatus === 'available'
                            ? 'border-[#22C55E]/60'
                            : usernameStatus === 'taken' || usernameStatus === 'invalid'
                              ? 'border-[#EF4444]/60'
                              : 'border-white/10 focus-within:border-[#5B7CFA]'
                        }`}
                      >
                        <span className="text-sm text-[#6B7280] select-none">@</span>
                        <input
                          id="auth-username"
                          type="text"
                          required
                          autoComplete="username"
                          value={username}
                          onChange={(e) =>
                            setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))
                          }
                          placeholder="your_handle"
                          maxLength={24}
                          className="w-full bg-transparent py-2.5 pl-1.5 text-sm text-white placeholder-[#6B7280] focus:outline-none"
                        />
                        {usernameStatus === 'checking' && (
                          <Loader2 className="w-4 h-4 animate-spin text-[#9CA3AF] shrink-0" />
                        )}
                        {usernameStatus === 'available' && (
                          <CheckCircle2 className="w-4 h-4 text-[#22C55E] shrink-0" />
                        )}
                        {(usernameStatus === 'taken' || usernameStatus === 'invalid') && (
                          <XCircle className="w-4 h-4 text-[#EF4444] shrink-0" />
                        )}
                      </div>
                      {usernameHint && (
                        <p
                          className={`mt-1 text-[11px] ${
                            usernameStatus === 'available' ? 'text-[#86EFAC]' : 'text-[#FCA5A5]'
                          }`}
                        >
                          {usernameHint}
                        </p>
                      )}
                    </div>

                    <div>
                      <label htmlFor="auth-display" className="block text-xs font-medium text-[#D1D5DB] mb-1.5">
                        Display Name
                      </label>
                      <input
                        id="auth-display"
                        type="text"
                        required
                        autoComplete="name"
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                        placeholder="Alex Rivera"
                        maxLength={48}
                        className="w-full rounded-xl bg-[#0B0D11] border border-white/10 px-3.5 py-2.5 text-sm text-white placeholder-[#6B7280] focus:outline-none focus:border-[#5B7CFA] transition-colors"
                      />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <div>
                <label htmlFor="auth-email" className="block text-xs font-medium text-[#D1D5DB] mb-1.5">
                  Email Address
                </label>
                <input
                  id="auth-email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full rounded-xl bg-[#0B0D11] border border-white/10 px-3.5 py-2.5 text-sm text-white placeholder-[#6B7280] focus:outline-none focus:border-[#5B7CFA] transition-colors"
                />
              </div>

              <div>
                <label htmlFor="auth-password" className="block text-xs font-medium text-[#D1D5DB] mb-1.5">
                  Password
                </label>
                <div className="flex items-center rounded-xl bg-[#0B0D11] border border-white/10 focus-within:border-[#5B7CFA] pr-2 transition-colors">
                  <input
                    id="auth-password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    minLength={6}
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="At least 6 characters"
                    className="w-full bg-transparent px-3.5 py-2.5 text-sm text-white placeholder-[#6B7280] focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="p-1.5 rounded-lg text-[#9CA3AF] hover:text-white transition-colors"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {mode === 'login' && (
                <div className="flex justify-end -mt-2">
                  <button
                    type="button"
                    onClick={handleForgotPassword}
                    disabled={loading}
                    className="text-xs text-[#7C96FF] hover:underline"
                  >
                    Forgot password?
                  </button>
                </div>
              )}

              <AnimatePresence>
                {error && (
                  <motion.div
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="rounded-xl bg-[#EF4444]/10 border border-[#EF4444]/30 px-3.5 py-2.5 text-xs text-[#FCA5A5] space-y-2"
                  >
                    <p>{error}</p>
                    {error.includes('Could not reach your Supabase project') && (
                      <button
                        type="button"
                        onClick={onOpenSetup}
                        className="font-semibold text-white underline hover:text-[#93C5FD]"
                      >
                        Update Supabase Connection
                      </button>
                    )}
                  </motion.div>
                )}

                {notice && (
                  <motion.div
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="rounded-xl bg-[#22C55E]/10 border border-[#22C55E]/30 px-3.5 py-2.5 text-xs text-[#86EFAC]"
                  >
                    {notice}
                  </motion.div>
                )}
              </AnimatePresence>

              <button
                type="submit"
                disabled={
                  loading ||
                  (mode === 'register' && (usernameStatus === 'taken' || usernameStatus === 'invalid'))
                }
                className="w-full flex items-center justify-center gap-2 rounded-xl bg-[#5B7CFA] hover:bg-[#4B6CF0] active:scale-[0.99] disabled:opacity-50 text-white text-sm font-semibold py-2.5 px-4 transition-all whitespace-nowrap"
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    <span>{mode === 'login' ? 'Sign In to DompicMEDIA' : 'Create Account'}</span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </form>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
