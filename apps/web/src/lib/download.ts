import { apiBlob } from './api';

/** Fetch a file with the session's token and hand it to the browser as a download (a plain link cannot send a bearer token). */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const url = URL.createObjectURL(await apiBlob(path));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
