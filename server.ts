import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { WebSocket, WebSocketServer } from 'ws';

dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUPABASE_HOST_RE = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i;

let runtimePublicSupabaseUrl = '';
let runtimePublicSupabaseAnonKey = '';

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

function getSupabaseUrl(): string {
  return normalizeSupabaseUrl(
    process.env.VITE_SUPABASE_URL ||
      process.env.SUPABASE_URL ||
      runtimePublicSupabaseUrl ||
      ''
  );
}

function getSupabaseAnonKey(): string {
  return (
    process.env.VITE_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    runtimePublicSupabaseAnonKey ||
    ''
  ).trim();
}

function isServiceRoleJwt(key: string): boolean {
  try {
    const parts = key.split('.');
    if (parts.length !== 3) return false;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      role?: string;
    };
    return payload.role === 'service_role';
  } catch {
    return false;
  }
}

function getServiceRoleKey(): string {
  return (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
}

function resolvePublicSupabaseParams(req?: Request): { url: string; anonKey: string } | null {
  const envUrl = getSupabaseUrl();
  const envAnon = getSupabaseAnonKey();
  if (envUrl && envAnon) {
    return { url: envUrl, anonKey: envAnon };
  }
  if (req) {
    const hdrUrl = normalizeSupabaseUrl(String(req.headers['x-supabase-url'] || ''));
    const hdrAnon = String(req.headers['x-supabase-anon-key'] || '').trim();
    if (SUPABASE_HOST_RE.test(hdrUrl) && hdrAnon.length >= 16) {
      return { url: hdrUrl, anonKey: hdrAnon };
    }
  }
  return null;
}

function createAdminClient(): SupabaseClient | null {
  const url = getSupabaseUrl();
  const serviceKey = getServiceRoleKey();
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function createUserClient(accessToken: string, url?: string, anonKey?: string): SupabaseClient | null {
  const finalUrl = url || getSupabaseUrl();
  const finalAnon = anonKey || getSupabaseAnonKey();
  if (!finalUrl || !finalAnon) return null;
  return createClient(finalUrl, finalAnon, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function extractBearer(req: Request): string | null {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return auth.slice(7).trim() || null;
}

async function runExpiredAttachmentCleanup(): Promise<{
  checked: number;
  deleted: number;
  failed: number;
  skippedReason?: string;
}> {
  const admin = createAdminClient();
  if (!admin) {
    return { checked: 0, deleted: 0, failed: 0, skippedReason: 'SUPABASE_SERVICE_ROLE_KEY not configured' };
  }

  const nowIso = new Date().toISOString();
  const { data: expiredRows, error: queryErr } = await admin
    .from('attachments')
    .select('id, storage_bucket, storage_path, cleanup_attempts')
    .lte('expires_at', nowIso)
    .is('deleted_at', null)
    .lt('cleanup_attempts', 5)
    .limit(100);

  if (queryErr) {
    console.error('[AttachmentCleanup] Query error:', queryErr.message);
    return { checked: 0, deleted: 0, failed: 1 };
  }

  if (!expiredRows || expiredRows.length === 0) {
    return { checked: 0, deleted: 0, failed: 0 };
  }

  let deleted = 0;
  let failed = 0;

  const byBucket = new Map<string, Array<{ id: string; path: string; attempts: number }>>();
  for (const row of expiredRows) {
    if (!row.storage_path) {
      await admin.from('attachments').update({ deleted_at: nowIso }).eq('id', row.id);
      deleted += 1;
      continue;
    }
    const list = byBucket.get(row.storage_bucket) || [];
    list.push({ id: row.id, path: row.storage_path, attempts: row.cleanup_attempts || 0 });
    byBucket.set(row.storage_bucket, list);
  }

  for (const [bucket, items] of byBucket.entries()) {
    const paths = items.map((i) => i.path);
    const { error: removeErr } = await admin.storage.from(bucket).remove(paths);
    if (removeErr) {
      console.error(`[AttachmentCleanup] Storage remove error (${bucket}):`, removeErr.message);
      for (const item of items) {
        await admin
          .from('attachments')
          .update({
            cleanup_attempts: item.attempts + 1,
            last_cleanup_error: removeErr.message.slice(0, 250),
          })
          .eq('id', item.id);
        failed += 1;
      }
    } else {
      const ids = items.map((i) => i.id);
      const { error: markErr } = await admin
        .from('attachments')
        .update({
          deleted_at: nowIso,
          storage_path: null,
          last_cleanup_error: null,
        })
        .in('id', ids);
      if (markErr) {
        console.error('[AttachmentCleanup] Mark deleted error:', markErr.message);
        failed += items.length;
      } else {
        deleted += items.length;
      }
    }
  }

  return { checked: expiredRows.length, deleted, failed };
}

interface RelayPeer {
  ws: WebSocket;
  userId: string;
  channelId: string;
}

const SOUND_NAMES = new Set([
  'startup',
  'click',
  'leave_call',
  'join_call',
  'mute',
  'camera',
  'post',
  'like',
]);
const SOUND_EXTS = new Set(['.wav', '.mp3', '.ogg', '.m4a', '.webm', '.aac', '.flac']);

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const rootSoundsDir = path.resolve(process.cwd(), 'Sounds');
  const publicSoundsDir = path.resolve(process.cwd(), 'public/Sounds');
  if (fs.existsSync(rootSoundsDir)) {
    app.use('/Sounds', express.static(rootSoundsDir));
    app.use('/sounds', express.static(rootSoundsDir));
  }
  if (fs.existsSync(publicSoundsDir)) {
    app.use('/Sounds', express.static(publicSoundsDir));
    app.use('/sounds', express.static(publicSoundsDir));
  }

  app.get('/api/sounds', (_req: Request, res: Response) => {
    const sounds: Record<string, string> = {};
    for (const dir of [rootSoundsDir, publicSoundsDir]) {
      if (!fs.existsSync(dir)) continue;
      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          const parsed = path.parse(file);
          const base = parsed.name.toLowerCase();
          const ext = parsed.ext.toLowerCase();
          if (!SOUND_NAMES.has(base) || !SOUND_EXTS.has(ext) || sounds[base]) continue;
          const stat = fs.statSync(path.join(dir, file));
          sounds[base] = `/Sounds/${encodeURIComponent(file)}?v=${Math.floor(stat.mtimeMs)}`;
        }
      } catch {
        // ignore unreadable dir
      }
    }
    res.json({ sounds });
  });

  app.get('/api/health', (_req: Request, res: Response) => {
    const hasTurn = Boolean(
      process.env.TURN_URL &&
        (process.env.TURN_STATIC_SECRET || (process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL))
    );
    res.json({
      ok: true,
      supabaseConfigured: Boolean(getSupabaseUrl() && getSupabaseAnonKey()),
      serviceRoleConfigured: Boolean(getServiceRoleKey()),
      turnConfigured: hasTurn,
      builtinRelayAvailable: true,
    });
  });

  app.get('/api/config', (_req: Request, res: Response) => {
    res.json({
      supabaseUrl: getSupabaseUrl() || null,
      supabaseAnonKey: getSupabaseAnonKey() || null,
    });
  });

  app.post('/api/config/public', async (req: Request, res: Response) => {
    const url = normalizeSupabaseUrl(String(req.body?.supabaseUrl || ''));
    const anonKey = String(req.body?.supabaseAnonKey || '').trim();

    if (!SUPABASE_HOST_RE.test(url)) {
      return res.status(400).json({
        error: 'Invalid Supabase URL. Use your Project API URL: https://<your-project-ref>.supabase.co',
      });
    }
    if (anonKey.length < 16) {
      return res.status(400).json({ error: 'Invalid Supabase public anon/publishable key.' });
    }
    if (isServiceRoleJwt(anonKey) || anonKey.startsWith('sb_secret_')) {
      return res.status(400).json({
        error: 'You entered a secret/service_role key. Only your public anon/publishable key is allowed here.',
      });
    }

    // Verify the Supabase project URL & key are reachable before saving (host strictly *.supabase.co)
    try {
      const checkRes = await fetch(`${url}/auth/v1/settings`, {
        headers: { apikey: anonKey },
        signal: AbortSignal.timeout(6000),
      });
      if (checkRes.status === 401 || checkRes.status === 403) {
        return res.status(400).json({
          error: 'Supabase rejected that public anon key. Double-check Project Settings -> API.',
        });
      }
      if (!checkRes.ok) {
        return res.status(400).json({
          error: `Could not reach Supabase Auth at ${url} (HTTP ${checkRes.status}). Is your project paused?`,
        });
      }
    } catch {
      return res.status(400).json({
        error: `Could not connect to ${url}. Verify your Project URL and ensure the project is active.`,
      });
    }

    runtimePublicSupabaseUrl = url;
    runtimePublicSupabaseAnonKey = anonKey;
    return res.json({ ok: true, supabaseUrl: url });
  });

  // Authenticated ICE server configuration + built-in WebSocket relay indicator
  app.get('/api/ice-servers', async (req: Request, res: Response) => {
    const token = extractBearer(req);
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const sb = resolvePublicSupabaseParams(req);
    if (!sb) {
      return res.status(503).json({ error: 'Supabase is not configured' });
    }

    const userClient = createUserClient(token, sb.url, sb.anonKey);
    if (!userClient) {
      return res.status(503).json({ error: 'Supabase client failed' });
    }

    const { data: authData, error: authErr } = await userClient.auth.getUser(token);
    if (authErr || !authData.user) {
      return res.status(401).json({ error: 'Invalid or expired session token' });
    }

    const iceServers: RTCIceServer[] = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'stun:stun.services.mozilla.com' },
    ];

    const turnUrl = (process.env.TURN_URL || '').trim();
    const turnStaticSecret = (process.env.TURN_STATIC_SECRET || '').trim();
    const turnUsername = (process.env.TURN_USERNAME || '').trim();
    const turnCredential = (process.env.TURN_CREDENTIAL || '').trim();
    let turnConfigured = false;

    if (turnUrl && turnStaticSecret) {
      const ttl = 3600;
      const unixExpiry = Math.floor(Date.now() / 1000) + ttl;
      const username = `${unixExpiry}:${authData.user.id}`;
      const credential = crypto.createHmac('sha1', turnStaticSecret).update(username).digest('base64');
      iceServers.push({
        urls: turnUrl.split(',').map((u) => u.trim()).filter(Boolean),
        username,
        credential,
      });
      turnConfigured = true;
    } else if (turnUrl && turnUsername && turnCredential) {
      iceServers.push({
        urls: turnUrl.split(',').map((u) => u.trim()).filter(Boolean),
        username: turnUsername,
        credential: turnCredential,
      });
      turnConfigured = true;
    }

    return res.json({ iceServers, turnConfigured, builtinRelayAvailable: true });
  });

  // Short-lived signed URL for private chat attachments (enforces access + 24-hour expiration)
  app.post('/api/attachments/signed-url', async (req: Request, res: Response) => {
    const token = extractBearer(req);
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const attachmentId = String(req.body?.attachmentId || '');
    if (!UUID_RE.test(attachmentId)) {
      return res.status(400).json({ error: 'Valid attachmentId is required' });
    }

    const sb = resolvePublicSupabaseParams(req);
    if (!sb) {
      return res.status(503).json({ error: 'Supabase is not configured' });
    }

    const userClient = createUserClient(token, sb.url, sb.anonKey);
    const adminClient = createAdminClient();
    if (!userClient) {
      return res.status(503).json({ error: 'Supabase is not configured' });
    }

    const { data: authData, error: authErr } = await userClient.auth.getUser(token);
    if (authErr || !authData.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { data: att, error: attErr } = await userClient
      .from('attachments')
      .select('id, storage_bucket, storage_path, expires_at, deleted_at')
      .eq('id', attachmentId)
      .single();

    if (attErr || !att) {
      return res.status(404).json({ error: 'Attachment not found or access denied' });
    }

    if (att.deleted_at || !att.storage_path) {
      return res.status(410).json({ error: 'Attachment expired' });
    }

    if (att.expires_at && new Date(att.expires_at).getTime() <= Date.now()) {
      return res.status(410).json({ error: 'Attachment expired' });
    }

    const storageClient = adminClient || userClient;
    const { data: signedData, error: signErr } = await storageClient.storage
      .from(att.storage_bucket)
      .createSignedUrl(att.storage_path, 60);

    if (signErr || !signedData?.signedUrl) {
      return res.status(500).json({ error: signErr?.message || 'Could not generate signed URL' });
    }

    return res.json({ signedUrl: signedData.signedUrl, expiresIn: 60 });
  });

  app.post('/api/attachments/cleanup', async (req: Request, res: Response) => {
    const token = extractBearer(req);
    const cronSecret = (process.env.CRON_SECRET || '').trim();

    let authorized = false;
    if (cronSecret && token && token === cronSecret) {
      authorized = true;
    } else if (token) {
      const userClient = createUserClient(token);
      const adminClient = createAdminClient();
      if (userClient && adminClient) {
        const { data: authData } = await userClient.auth.getUser(token);
        if (authData.user) {
          const { data: prof } = await adminClient
            .from('profiles')
            .select('platform_role')
            .eq('id', authData.user.id)
            .single();
          if (prof?.platform_role === 'platform_admin') {
            authorized = true;
          }
        }
      }
    }

    if (!authorized) {
      return res.status(403).json({ error: 'Forbidden: requires CRON_SECRET or platform_admin' });
    }

    const result = await runExpiredAttachmentCleanup();
    return res.json(result);
  });

  app.post('/api/emojis/seed', async (req: Request, res: Response) => {
    const token = extractBearer(req);
    if (!token) return res.status(401).json({ error: 'Authentication required' });

    const userClient = createUserClient(token);
    const adminClient = createAdminClient();
    if (!userClient || !adminClient) {
      return res.status(503).json({ error: 'Server requires SUPABASE_SERVICE_ROLE_KEY for emoji seeding' });
    }

    const { data: authData } = await userClient.auth.getUser(token);
    if (!authData.user) return res.status(401).json({ error: 'Unauthorized' });

    const { data: prof } = await adminClient
      .from('profiles')
      .select('platform_role')
      .eq('id', authData.user.id)
      .single();

    if (prof?.platform_role !== 'platform_admin') {
      return res.status(403).json({ error: 'Only platform administrators can seed global emojis' });
    }

    const emojiDir = path.resolve(process.cwd(), 'public/emojis');
    if (!fs.existsSync(emojiDir)) {
      return res.status(404).json({ error: 'Local emoji assets directory not found' });
    }

    const files = fs.readdirSync(emojiDir).filter((f) => f.endsWith('.png'));
    const seeded: string[] = [];

    for (const file of files) {
      const shortcode = file.replace(/\.png$/i, '').toLowerCase();
      const fileBuf = fs.readFileSync(path.join(emojiDir, file));
      const storagePath = `global/${shortcode}.png`;

      const { error: uploadErr } = await adminClient.storage
        .from('emojis')
        .upload(storagePath, fileBuf, { contentType: 'image/png', upsert: true });

      if (uploadErr) {
        return res.status(500).json({ error: `Failed uploading ${file}: ${uploadErr.message}` });
      }

      const { data: pub } = adminClient.storage.from('emojis').getPublicUrl(storagePath);

      const { error: upsertErr } = await adminClient.from('global_emojis').upsert(
        {
          shortcode,
          label: shortcode.charAt(0).toUpperCase() + shortcode.slice(1),
          storage_path: storagePath,
          public_url: pub.publicUrl,
          width: 128,
          height: 128,
          created_by: authData.user.id,
        },
        { onConflict: 'shortcode' }
      );

      if (upsertErr) {
        return res.status(500).json({ error: `Failed saving ${shortcode}: ${upsertErr.message}` });
      }
      seeded.push(shortcode);
    }

    return res.json({ ok: true, count: seeded.length, seeded });
  });

  if (getServiceRoleKey() && getSupabaseUrl()) {
    setInterval(() => {
      runExpiredAttachmentCleanup().catch((err) => {
        console.error('[AttachmentCleanup] Periodic sweep failed:', err);
      });
    }, 15 * 60 * 1000);
  }

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const httpServer = http.createServer(app);

  // Built-in authenticated WebSocket Voice/Video Media Relay (/ws/voice)
  // Zero third-party signup required; relays live frames in RAM without recording.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
  const relayRooms = new Map<string, Set<RelayPeer>>();

  httpServer.on('upgrade', async (request, socket, head) => {
    try {
      const reqUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
      if (reqUrl.pathname !== '/ws/voice') {
        return; // Allow Vite or other handlers to handle non-voice upgrades
      }

      const channelId = reqUrl.searchParams.get('channelId') || '';
      const token = reqUrl.searchParams.get('token') || '';
      const paramUrl = normalizeSupabaseUrl(reqUrl.searchParams.get('sbUrl') || '');
      const paramAnon = (reqUrl.searchParams.get('sbAnon') || '').trim();

      if (!UUID_RE.test(channelId) || !token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const envUrl = getSupabaseUrl();
      const envAnon = getSupabaseAnonKey();
      const sbUrl = envUrl || (SUPABASE_HOST_RE.test(paramUrl) ? paramUrl : '');
      const sbAnon = envAnon || (paramAnon.length > 20 ? paramAnon : '');

      if (!sbUrl || !sbAnon) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
        socket.destroy();
        return;
      }

      const userClient = createUserClient(token, sbUrl, sbAnon);
      if (!userClient) {
        socket.destroy();
        return;
      }

      const { data: authData, error: authErr } = await userClient.auth.getUser(token);
      if (authErr || !authData.user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      // RLS enforces that only authorized members of the server can read the channel
      const { data: chData, error: chErr } = await userClient
        .from('server_channels')
        .select('id, type')
        .eq('id', channelId)
        .single();

      if (chErr || !chData || chData.type !== 'voice') {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      const userId = authData.user.id;
      wss.handleUpgrade(request, socket, head, (ws) => {
        const peer: RelayPeer = { ws, userId, channelId };
        let room = relayRooms.get(channelId);
        if (!room) {
          room = new Set();
          relayRooms.set(channelId, room);
        }
        room.add(peer);

        ws.on('message', (raw, isBinary) => {
          const activeRoom = relayRooms.get(channelId);
          if (!activeRoom) return;

          if (isBinary && Buffer.isBuffer(raw)) {
            // Binary audio frame: prepend 36-byte ASCII userId so receivers know sender
            const idBuf = Buffer.from(userId, 'utf8');
            const out = Buffer.concat([idBuf, raw]);
            for (const other of activeRoom) {
              if (other.userId !== userId && other.ws.readyState === WebSocket.OPEN) {
                other.ws.send(out, { binary: true });
              }
            }
          } else {
            // JSON video/control frame: stamp server-verified senderId
            try {
              const parsed = JSON.parse(raw.toString()) as { type?: string; frame?: string };
              if (parsed.type === 'video-frame' && typeof parsed.frame === 'string') {
                const msg = JSON.stringify({
                  type: 'video-frame',
                  senderId: userId,
                  frame: parsed.frame,
                });
                for (const other of activeRoom) {
                  if (other.userId !== userId && other.ws.readyState === WebSocket.OPEN) {
                    other.ws.send(msg);
                  }
                }
              } else if (parsed.type === 'video-off') {
                const msg = JSON.stringify({
                  type: 'video-off',
                  senderId: userId,
                });
                for (const other of activeRoom) {
                  if (other.userId !== userId && other.ws.readyState === WebSocket.OPEN) {
                    other.ws.send(msg);
                  }
                }
              }
            } catch {
              // ignore malformed JSON
            }
          }
        });

        ws.on('close', () => {
          const r = relayRooms.get(channelId);
          if (r) {
            r.delete(peer);
            if (r.size === 0) relayRooms.delete(channelId);
          }
        });
      });
    } catch {
      socket.destroy();
    }
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`DompicMEDIA server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start DompicMEDIA server:', err);
  process.exit(1);
});
