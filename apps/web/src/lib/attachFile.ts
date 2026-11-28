/** What the server stores (apps/api files), with the extension a pasted one is named with. */
const STORED: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'application/pdf': 'pdf' };

/** Whether a pasted or dropped file of `type` may go into a picker with this `accept` list ("image/*,application/pdf"). */
export function canAttach(type: string, accept: string): boolean {
  if (!(type in STORED)) return false;
  return accept.split(',').some((a) => {
    const rule = a.trim();
    return rule === type || (rule.endsWith('/*') && type.startsWith(rule.slice(0, -1)));
  });
}

/**
 * A clipboard picture arrives with no name, or the browser's stand-in "image.png"; call it a
 * screenshot instead. A copied file keeps its own name.
 */
export function pastedName(name: string, type: string): string {
  return name && !/^image\.\w+$/i.test(name) ? name : `screenshot.${STORED[type] ?? 'png'}`;
}

/** The first pasted file this picker accepts, ready to attach; null when there is none. */
export function pastedFile(files: Iterable<File>, accept: string): File | null {
  const found = [...files].find((f) => canAttach(f.type, accept));
  return found ? new File([found], pastedName(found.name, found.type), { type: found.type }) : null;
}

/** Whether this browser lets a button read a picture from the clipboard (needs HTTPS or localhost). */
export const canReadClipboard = (): boolean => typeof navigator !== 'undefined' && typeof navigator.clipboard?.read === 'function';

/** The picture on the clipboard, for the paste button; null when there is none. Throws if not allowed. */
export async function readClipboardFile(accept: string): Promise<File | null> {
  for (const item of await navigator.clipboard.read()) {
    const type = item.types.find((x) => canAttach(x, accept));
    if (type) return new File([await item.getType(type)], pastedName('', type), { type });
  }
  return null;
}
