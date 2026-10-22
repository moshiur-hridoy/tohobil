import * as Dialog from '@radix-ui/react-dialog';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api, apiBlob } from '../lib/api';
import { useAuth } from '../lib/auth';
import { errorMessage } from '../lib/errors';
import type { MemberDetail } from '../lib/types';
import { uuid } from '../lib/uuid';
import { BTN_PRIMARY, BTN_SECONDARY } from './admin';
import { Icon } from './ui';

/**
 * A member's round picture: their photo when they have one, otherwise `fallback` (the first letter
 * or the member code) in the same circle. `<img src>` cannot send the bearer token, so the thumbnail
 * is fetched with it; a photo that fails to load falls back quietly.
 */
export function Avatar({ fileId, fallback, className }: { fileId: string | null | undefined; fallback: ReactNode; className: string }) {
  const photo = useQuery({
    queryKey: ['file', fileId, true],
    queryFn: async () => URL.createObjectURL(await apiBlob(`/files/${fileId}?thumb=true`)),
    enabled: !!fileId,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    retry: false,
  });
  if (fileId && photo.data) return <img src={photo.data} alt="" className={`shrink-0 rounded-full object-cover ${className}`} />;
  return <span className={`grid shrink-0 place-items-center rounded-full ${className}`}>{fallback}</span>;
}

/** The signed-in member's own photo id (from their member record). */
export function useMyPhoto(): string | null {
  const { me } = useAuth();
  const q = useQuery({
    queryKey: ['member', me?.member_id],
    queryFn: () => api<MemberDetail>(`/members/${me?.member_id}`),
    enabled: !!me?.member_id,
    staleTime: 5 * 60_000,
  });
  return q.data?.photo_file_id ?? null;
}

/**
 * Add, change or remove a profile photo. A member edits their own (`PATCH /members/me`); the cashier
 * can do it for anyone from the members page (`PUT /members/:id/photo`, written to the audit log).
 * Photos are optional and every member can see them.
 */
export function PhotoSheet({ open, onClose, memberId, name, fileId, asCashier = false }: {
  open: boolean;
  onClose: () => void;
  memberId: string;
  name: string;
  fileId: string | null;
  asCashier?: boolean;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async (photo: string | null) => {
    await (asCashier
      ? api(`/members/${memberId}/photo`, { method: 'PUT', body: { photo_file_id: photo } })
      : api('/members/me', { method: 'PATCH', body: { photo_file_id: photo } }));
    await Promise.all([qc.invalidateQueries({ queryKey: ['members'] }), qc.invalidateQueries({ queryKey: ['member'] }), qc.invalidateQueries({ queryKey: ['matrix'] })]);
  };

  const run = async (kind: 'upload' | 'remove', work: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(errorMessage(t, err).message);
    } finally {
      setBusy(null);
    }
  };

  const upload = (file: File) =>
    run('upload', async () => {
      const form = new FormData();
      form.append('file', file);
      const up = await api<{ id: string }>('/files', { method: 'POST', body: form, headers: { 'Idempotency-Key': uuid() } });
      await save(up.id);
    });

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          aria-describedby="photo-sheet-hint"
          className="fixed inset-x-0 bottom-0 z-50 mx-auto max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-[24px] border border-border bg-card p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-lg sm:bottom-auto sm:top-1/2 sm:-translate-y-1/2 sm:rounded-[24px]"
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <Dialog.Title className="text-lg font-bold">{asCashier ? t('photo.titleFor', { name }) : t('photo.title')}</Dialog.Title>
            <Dialog.Close aria-label={t('common.close')} disabled={!!busy} className="grid h-10 w-10 place-items-center rounded-full text-muted hover:bg-hover">
              <Icon d="M6 6l12 12M18 6L6 18" size={20} />
            </Dialog.Close>
          </div>

          <div className="flex flex-col items-center gap-3 py-2">
            <Avatar fileId={fileId} fallback={name.trim().charAt(0)} className="h-28 w-28 bg-primary-soft text-4xl font-bold text-primary" />
            <p id="photo-sheet-hint" className="text-center text-sm text-muted">{t(asCashier ? 'photo.hintCashier' : 'photo.hint')}</p>
          </div>

          <input
            ref={input}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            tabIndex={-1}
            aria-label={t('photo.choose')}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void upload(file);
            }}
          />
          {error && <p role="alert" className="mb-2 text-center text-sm font-semibold text-bad">{error}</p>}
          <div className="flex flex-col gap-2">
            <button type="button" disabled={!!busy} onClick={() => input.current?.click()} className={`${BTN_PRIMARY} w-full`}>
              {busy === 'upload' ? t('photo.uploading') : t(fileId ? 'photo.change' : 'photo.choose')}
            </button>
            {fileId && (
              <button type="button" disabled={!!busy} onClick={() => void run('remove', () => save(null))} className={`${BTN_SECONDARY} w-full text-bad`}>
                {busy === 'remove' ? t('common.working') : t('photo.remove')}
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
