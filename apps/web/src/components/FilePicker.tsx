import { useEffect, useRef, useState, type DragEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { canAttach, canReadClipboard, pastedFile, readClipboardFile } from '../lib/attachFile';
import { Icon } from './ui';

/** Every picker on screen, so one Ctrl+V lands in exactly one of them. */
const pickers = new Set<HTMLElement>();

/**
 * Ctrl+V (⌘V) attaches a copied screenshot. It goes to the picker under the pointer or holding the
 * focus; otherwise to the only one on screen. With several and none pointed at, nothing happens: a
 * receipt must not land on the wrong line.
 */
function usePaste(box: RefObject<HTMLDivElement | null>, accept: string, onPaste: (file: File) => void) {
  const latest = useRef(onPaste);
  latest.current = onPaste;
  useEffect(() => {
    const me = box.current;
    if (!me) return;
    pickers.add(me);
    const listen = (e: ClipboardEvent) => {
      if (e.defaultPrevented || !e.clipboardData) return;
      const file = pastedFile(e.clipboardData.files, accept);
      if (!file) return;
      // Copied text that carries a picture too (from a document, say) stays a text paste in a text box.
      const typing = e.target instanceof HTMLElement && e.target.matches('input, textarea, [contenteditable="true"]');
      if (typing && e.clipboardData.types.includes('text/plain')) return;
      // Pickers behind an open dialog (aria-hidden by the dialog) or folded away do not count.
      const shown = [...pickers].filter((el) => !el.closest('[aria-hidden="true"], [inert]') && el.getClientRects().length > 0);
      const target = shown.find((el) => el.matches(':hover') || el.contains(document.activeElement)) ?? (shown.length === 1 ? shown[0] : null);
      if (target !== me) return;
      e.preventDefault();
      latest.current(file);
    };
    document.addEventListener('paste', listen);
    return () => {
      pickers.delete(me);
      document.removeEventListener('paste', listen);
    };
  }, [box, accept]);
}

const carriesFiles = (data: DataTransfer | null) => data?.types.includes('Files') ?? false;

/** A file dropped beside a picker must not make the browser open it and throw the half-filled form away. */
function useNoStrayDrop() {
  useEffect(() => {
    const block = (e: globalThis.DragEvent) => {
      // a picker that takes the file has already claimed the event
      if (e.defaultPrevented || !carriesFiles(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
    };
    document.addEventListener('dragover', block);
    document.addEventListener('drop', block);
    return () => {
      document.removeEventListener('dragover', block);
      document.removeEventListener('drop', block);
    };
  }, []);
}

/** A small look at an attached picture, so a pasted or dropped one can be checked before saving. */
function Preview({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url ? <img src={url} alt="" className="max-h-40 w-full rounded-lg bg-card object-contain" /> : null;
}

/**
 * Pick a photo or a PDF, drag one in, or paste a copied screenshot, in Bengali throughout: the browser's
 * own file input would say "Choose File / No file chosen" in the phone's language. The real input stays
 * hidden; once a file is picked its name is shown with "বদলান" (change) and "সরান" (remove).
 */
export function FilePicker({ file, onChange, accept = 'image/*,application/pdf', label, className = '' }: { file: File | null; onChange: (file: File | null) => void; accept?: string; label?: string; className?: string }) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<'pasteEmpty' | 'pasteBlocked' | 'wrongType' | null>(null);
  const [dragging, setDragging] = useState(false);
  const attach = (next: File | null) => {
    setProblem(null);
    onChange(next);
  };
  const pick = () => input.current?.click();
  const paste = async () => {
    setProblem(null);
    try {
      const found = await readClipboardFile(accept);
      if (found) attach(found);
      else setProblem('pasteEmpty');
    } catch {
      setProblem('pasteBlocked');
    }
  };
  usePaste(box, accept, attach);
  useNoStrayDrop();

  const over = (e: DragEvent) => {
    if (!carriesFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragging(true);
  };
  const drop = (e: DragEvent) => {
    if (!carriesFiles(e.dataTransfer)) return;
    e.preventDefault();
    setDragging(false);
    const found = [...e.dataTransfer.files].find((f) => canAttach(f.type, accept));
    if (found) attach(found);
    else setProblem('wrongType');
  };

  return (
    <div
      ref={box}
      className={className}
      onDragEnter={over}
      onDragOver={over}
      // leaving for one of its own children is not leaving
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDragging(false)}
      onDrop={drop}
    >
      <input
        ref={input}
        type="file"
        accept={accept}
        aria-label={label ?? t('file.add')}
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          attach(e.target.files?.[0] ?? null);
          // Cleared so picking the same file again after "সরান" still fires a change.
          e.target.value = '';
        }}
      />
      {!file ? (
        <div className={`rounded-lg border-[1.5px] focus-within:border-accent hover:border-accent ${dragging ? 'border-dashed border-accent bg-accent-soft' : 'border-edge bg-soft'}`}>
          <button type="button" onClick={pick} className="flex w-full items-center gap-3 rounded-lg p-3 text-left">
            <span aria-hidden="true" className="grid h-10 w-10 flex-none place-items-center rounded-lg bg-accent-soft text-accent">
              <Icon d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" size={20} />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-accent">{t(dragging ? 'file.dropHere' : 'file.add')}</span>
              <span className="block text-xs text-muted">
                {t('file.hint')}
                {/* dragging and keys mean nothing on a touch screen */}
                <span className="[@media(pointer:coarse)]:hidden"> · {t('file.desktopHint')}</span>
              </span>
            </span>
          </button>
          {canReadClipboard() && (
            <button type="button" onClick={() => void paste()} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-b-lg border-t border-edge text-sm font-semibold text-accent hover:bg-hover">
              <Icon d="M9 4h6v3H9zM9 5H6v16h12V5h-3" size={18} />
              {t('file.paste')}
            </button>
          )}
        </div>
      ) : (
        <div className={`space-y-2 rounded-lg border-[1.5px] border-accent bg-accent-soft p-3 ${dragging ? 'border-dashed' : ''}`}>
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="grid h-10 w-10 flex-none place-items-center rounded-lg bg-card text-accent">
              <Icon d="M20 6L9 17l-5-5" size={20} sw={2} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-xs text-muted">{t('file.attached')}</span>
              <span className="block truncate text-sm font-semibold">{file.name}</span>
            </span>
            <button type="button" onClick={pick} className="min-h-11 rounded-md px-2 text-sm font-semibold text-accent hover:bg-hover">{t('file.change')}</button>
            <button type="button" onClick={() => attach(null)} className="min-h-11 rounded-md px-2 text-sm font-semibold text-bad hover:bg-hover">{t('file.remove')}</button>
          </div>
          {file.type.startsWith('image/') && <Preview file={file} />}
        </div>
      )}
      {problem && <p role="alert" className="mt-1.5 text-xs font-normal text-bad">{t(`file.${problem}`)}</p>}
    </div>
  );
}
