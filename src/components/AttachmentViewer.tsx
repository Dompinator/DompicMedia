import React, { useEffect, useState } from 'react';
import { Clock, Download, FileText, Music } from 'lucide-react';
import { AttachmentRecord } from '../types';
import { getActiveSupabaseConfig, getSupabase } from '../lib/supabase';
import { formatFileSize } from '../lib/utils';

export function AttachmentItem({ attachment }: { attachment: AttachmentRecord }) {
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [expired, setExpired] = useState<boolean>(
    Boolean(
      attachment.deleted_at ||
        !attachment.storage_path ||
        (attachment.expires_at && new Date(attachment.expires_at).getTime() <= Date.now())
    )
  );
  const [loading, setLoading] = useState<boolean>(!expired);

  useEffect(() => {
    if (expired) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    async function fetchSigned() {
      try {
        const supabase = getSupabase();
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) return;

        const sbCfg = getActiveSupabaseConfig();
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        };
        if (sbCfg) {
          headers['x-supabase-url'] = sbCfg.supabaseUrl;
          headers['x-supabase-anon-key'] = sbCfg.supabaseAnonKey;
        }

        const res = await fetch(`${import.meta.env.BASE_URL}api/attachments/signed-url`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ attachmentId: attachment.id }),
        }).catch(() => null);

        if (cancelled) return;
        if (res?.status === 410) {
          setExpired(true);
          setLoading(false);
          return;
        }
        const isJson = res?.headers.get('content-type')?.includes('application/json');
        if (res?.ok && isJson) {
          const data = (await res.json()) as { signedUrl: string };
          setSignedUrl(data.signedUrl);
          return;
        }

        // Static hosting fallback (GitHub Pages): use authenticated RLS Storage signed URL directly
        if (attachment.storage_path) {
          const { data: signedData } = await supabase.storage
            .from(attachment.storage_bucket)
            .createSignedUrl(attachment.storage_path, 60);
          if (!cancelled && signedData?.signedUrl) {
            setSignedUrl(signedData.signedUrl);
          }
        }
      } catch {
        // leave null
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchSigned();
    return () => {
      cancelled = true;
    };
  }, [attachment.id, attachment.storage_bucket, attachment.storage_path, expired]);

  if (expired) {
    return (
      <div className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-[#12151C] border border-white/10 text-xs text-[#9CA3AF]">
        <Clock className="w-3.5 h-3.5 text-[#F59E0B] shrink-0" />
        <span>Attachment expired</span>
        <span className="text-[#6B7280]">({attachment.file_name})</span>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="h-24 w-56 rounded-lg bg-white/5 animate-pulse border border-white/5" />
    );
  }

  if (!signedUrl) {
    return (
      <div className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-[#12151C] border border-white/10 text-xs text-[#9CA3AF]">
        <FileText className="w-3.5 h-3.5 shrink-0" />
        <span>Attachment unavailable</span>
      </div>
    );
  }

  if (attachment.category === 'image') {
    return (
      <a href={signedUrl} target="_blank" rel="noreferrer" className="block max-w-sm">
        <img
          src={signedUrl}
          alt={attachment.file_name}
          referrerPolicy="no-referrer"
          className="rounded-xl max-h-72 w-auto object-cover border border-white/10 hover:opacity-95 transition-opacity"
        />
      </a>
    );
  }

  if (attachment.category === 'video') {
    return (
      <div className="max-w-md rounded-xl overflow-hidden border border-white/10 bg-black">
        <video src={signedUrl} controls preload="metadata" className="w-full max-h-72" />
      </div>
    );
  }

  if (attachment.category === 'audio') {
    return (
      <div className="max-w-sm rounded-xl border border-white/10 bg-[#12151C] p-3">
        <div className="flex items-center gap-2 text-xs text-[#D1D5DB] mb-2 truncate">
          <Music className="w-3.5 h-3.5 text-[#5B7CFA] shrink-0" />
          <span className="truncate">{attachment.file_name}</span>
          <span className="text-[#6B7280] font-mono tabular-nums shrink-0">
            {formatFileSize(attachment.file_size)}
          </span>
        </div>
        <audio src={signedUrl} controls preload="metadata" className="w-full h-9" />
        <a
          href={signedUrl}
          target="_blank"
          rel="noreferrer"
          download={attachment.file_name}
          className="inline-flex items-center gap-1 mt-2 text-[11px] text-[#7C96FF] hover:underline"
        >
          <Download className="w-3 h-3" /> Download
        </a>
      </div>
    );
  }

  return (
    <a
      href={signedUrl}
      download={attachment.file_name}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-3 px-3.5 py-2.5 rounded-xl bg-[#12151C] border border-white/10 hover:border-white/20 transition-colors max-w-sm"
    >
      <FileText className="w-4 h-4 text-[#5B7CFA] shrink-0" />
      <div className="min-w-0">
        <div className="text-xs font-medium text-white truncate">{attachment.file_name}</div>
        <div className="text-[11px] text-[#9CA3AF] font-mono tabular-nums">
          {formatFileSize(attachment.file_size)}
        </div>
      </div>
      <Download className="w-4 h-4 text-[#9CA3AF] shrink-0 ml-1" />
    </a>
  );
}
