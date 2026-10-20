import { randomBytes } from 'node:crypto';

export interface FormPart {
  name: string;
  data: Buffer | string;
  filename?: string;
  contentType?: string;
}

/** Build a multipart/form-data body by hand for `app.inject` (no extra dependency needed). */
export function multipartBody(parts: FormPart[]): { payload: Buffer; contentType: string } {
  const boundary = `----barakah${randomBytes(8).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename !== undefined) head += `; filename="${part.filename}"`;
    head += '\r\n';
    if (part.contentType) head += `Content-Type: ${part.contentType}\r\n`;
    chunks.push(Buffer.from(`${head}\r\n`), Buffer.from(part.data), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
