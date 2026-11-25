import { createClient, SupabaseClient } from '@supabase/supabase-js';

const STORAGE_KEY = 'vesper_public_supabase_config';
const SUPABASE_HOST_RE = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i;

interface PublicSupabaseConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

let clientInstance: SupabaseClient | null = null;
let activeConfig: PublicSupabaseConfig | null = null;

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  timeoutMessage: string
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new Error(timeoutMessage);
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

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

function isServiceRoleKeyClient(key: string): boolean {
  if (key.startsWith('sb_secret_')) return true;
  try {
    const parts = key.split('.');
    if (parts.length !== 3) return false;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(b64)) as { role?: string };
    return json.role === 'service_role';
  } catch {
    return false;
  }
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

async function verifySupabaseDirect(cfg: PublicSupabaseConfig): Promise<PublicSupabaseConfig> {
  if (!SUPABASE_HOST_RE.test(cfg.supabaseUrl)) {
    throw new Error('Invalid Supabase URL. Use your Project API URL: https://<your-project-ref>.supabase.co');
  }
  if (isServiceRoleKeyClient(cfg.supabaseAnonKey)) {
    throw new Error('You entered a secret/service_role key. Only your public anon/publishable key is allowed here.');
  }

  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${cfg.supabaseUrl}/auth/v1/settings`,
      { headers: { apikey: cfg.supabaseAnonKey } },
      12000,
      'Supabase did not respond within 12 seconds. Check that the project is active and the Project URL is correct.'
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes('12 seconds')) throw error;
    throw new Error('Could not reach Supabase. Check the Project URL, public key, project status, and network connection.');
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error('Supabase rejected that public key. Double-check Project Settings -> API.');
  }
  if (!res.ok) {
    throw new Error(`Could not reach Supabase Auth at ${cfg.supabaseUrl} (HTTP ${res.status}).`);
  }
  return cfg;
}

async function syncPublicConfigToServer(
  cfg: PublicSupabaseConfig,
  strict: boolean
): Promise<PublicSupabaseConfig> {
  try {
    const res = await fetchWithTimeout(
      `${import.meta.env.BASE_URL}api/config/public`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      },
      4000,
      'Server configuration endpoint timed out.'
    );
    const isJson = res.headers.get('content-type')?.includes('application/json');
    if (!isJson || res.status === 404 || res.status === 405) {
      // Running on static hosting (e.g. GitHub Pages) without Express backend: verify directly
      return strict ? await verifySupabaseDirect(cfg) : cfg;
    }
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
  } catch (err) {
    if (!strict) return cfg;
    if (err instanceof Error && !/failed to fetch|timed out/i.test(err.message)) {
      throw err;
    }
    // Static hosts do not provide this API route; fall back to a direct Supabase check.
    return verifySupabaseDirect(cfg);
  }
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
    const res = await fetch(`${import.meta.env.BASE_URL}api/config`);
    const isJson = res.headers.get('content-type')?.includes('application/json');
    if (res.ok && isJson) {
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
    // fallback to browser saved config
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
