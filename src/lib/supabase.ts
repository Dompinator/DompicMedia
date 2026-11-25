import { createClient, SupabaseClient } from '@supabase/supabase-js';

const STORAGE_KEY = 'vesper_public_supabase_config';

interface PublicSupabaseConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

let clientInstance: SupabaseClient | null = null;
let activeConfig: PublicSupabaseConfig | null = null;

function normalizeSupabaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  const dashMatch = trimmed.match(/^https:\/\/supabase\.com\/dashboard\/project\/([a-z0-9-]+)/i);
  if (dashMatch?.[1]) {
    return `https://${dashMatch[1]}.supabase.co`;
  }
  const hostMatch = trimmed.match(/^(https:\/\/[a-z0-9-]+\.supabase\.co)(?:\/.*)?$/i);
  if (hostMatch?.[1]) {
    return hostMatch[1];
  }
  return trimmed;
}

function readBrowserSavedConfig(): PublicSupabaseConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PublicSupabaseConfig>;
    if (
      typeof parsed.supabaseUrl === 'string' &&
      parsed.supabaseUrl.startsWith('https://') &&
      typeof parsed.supabaseAnonKey === 'string' &&
      parsed.supabaseAnonKey.length >= 16
    ) {
      return {
        supabaseUrl: normalizeSupabaseUrl(parsed.supabaseUrl),
        supabaseAnonKey: parsed.supabaseAnonKey.trim(),
      };
    }
  } catch {
    // ignore malformed localStorage
  }
  return null;
}

async function syncPublicConfigToServer(
  cfg: PublicSupabaseConfig,
  strict: boolean
): Promise<PublicSupabaseConfig> {
  const res = await fetch('/api/config/public', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  });
  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    supabaseUrl?: string;
  };
  if (!res.ok) {
    if (strict) {
      throw new Error(data.error || 'Could not validate Supabase connection.');
    }
    return cfg;
  }
  return {
    supabaseUrl: data.supabaseUrl || cfg.supabaseUrl,
    supabaseAnonKey: cfg.supabaseAnonKey,
  };
}

export async function initSupabase(): Promise<{
  client: SupabaseClient | null;
  source: 'env' | 'server' | 'browser' | 'none';
}> {
  const envUrl = (import.meta.env.VITE_SUPABASE_URL || '').trim();
  const envAnon = (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim();

  if (envUrl && envAnon) {
    activeConfig = { supabaseUrl: normalizeSupabaseUrl(envUrl), supabaseAnonKey: envAnon };
    clientInstance = createClient(activeConfig.supabaseUrl, activeConfig.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
    return { client: clientInstance, source: 'env' };
  }

  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      const data = (await res.json()) as { supabaseUrl: string | null; supabaseAnonKey: string | null };
      if (data.supabaseUrl && data.supabaseAnonKey) {
        activeConfig = {
          supabaseUrl: normalizeSupabaseUrl(data.supabaseUrl),
          supabaseAnonKey: data.supabaseAnonKey,
        };
        clientInstance = createClient(activeConfig.supabaseUrl, activeConfig.supabaseAnonKey, {
          auth: { persistSession: true, autoRefreshToken: true },
        });
        return { client: clientInstance, source: 'server' };
      }
    }
  } catch {
    // fallback to browser saved public config
  }

  const saved = readBrowserSavedConfig();
  if (saved) {
    activeConfig = saved;
    clientInstance = createClient(saved.supabaseUrl, saved.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
    syncPublicConfigToServer(saved, false).catch(() => {});
    return { client: clientInstance, source: 'browser' };
  }

  clientInstance = null;
  activeConfig = null;
  return { client: null, source: 'none' };
}

export function getSupabase(): SupabaseClient {
  if (!clientInstance) {
    throw new Error('Supabase client is not initialized yet.');
  }
  return clientInstance;
}

export function getActiveSupabaseConfig(): PublicSupabaseConfig | null {
  return activeConfig;
}

export async function saveBrowserSupabaseConfig(url: string, anonKey: string): Promise<SupabaseClient> {
  const cleanUrl = normalizeSupabaseUrl(url);
  const cleanKey = anonKey.trim();
  if (!cleanUrl.startsWith('https://')) {
    throw new Error('Supabase URL must start with https://');
  }
  if (cleanKey.length < 16) {
    throw new Error('Please enter a valid Supabase public anon/publishable key.');
  }

  const verifiedCfg = await syncPublicConfigToServer(
    { supabaseUrl: cleanUrl, supabaseAnonKey: cleanKey },
    true
  );

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(verifiedCfg));
  } catch {
    // ignore storage quota/iframe restrictions; server session still holds it
  }
  activeConfig = verifiedCfg;
  clientInstance = createClient(verifiedCfg.supabaseUrl, verifiedCfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  return clientInstance;
}

export function clearBrowserSupabaseConfig(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  clientInstance = null;
  activeConfig = null;
}
