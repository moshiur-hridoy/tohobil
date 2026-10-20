import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import { FILE_MAX_BYTES, THUMBNAIL_MAX_SIDE, createFakeClock } from '@barakah/shared';
import { buildApp } from '../app';
import { createTestDb, type TestDb } from '../test/db-harness';
import {
  activateAndLogin,
  addConfirmedPayment,
  seedFund,
  testEnv,
  type Fund,
} from '../test/fund-fixture';
import { multipartBody } from '../test/multipart';

const clock = createFakeClock(new Date());
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let db: TestDb | null;
let app: FastifyInstance;
let fund: Fund;
let dir: string;
const token = {} as Record<'M01' | 'M02' | 'M03' | 'M04' | 'M07', string>;

// ---- sample files ---------------------------------------------------------------------------

/** 200x100 red JPEG carrying EXIF (an owner name) and a "rotate 90 degrees" orientation. */
const jpegWithExif = () =>
  sharp({ create: { width: 200, height: 100, channels: 3, background: '#cc2222' } })
    .jpeg()
    .withExif({ IFD0: { Copyright: 'secret-owner-name', ImageDescription: 'home gps' } })
    .withMetadata({ orientation: 6 })
    .toBuffer();
const png = () =>
  sharp({
    create: { width: 40, height: 30, channels: 4, background: { r: 0, g: 128, b: 0, alpha: 0.5 } },
  })
    .png()
    .toBuffer();
const webp = () =>
  sharp({ create: { width: 64, height: 64, channels: 3, background: '#2222cc' } })
    .webp()
    .toBuffer();
const bigJpeg = () =>
  sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#112233' } })
    .jpeg()
    .toBuffer();
const pdf = (extra = '') =>
  Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n${extra}`);

// ---- helpers --------------------------------------------------------------------------------

interface UploadOpts {
  name?: string;
  data: Buffer | string;
  declared?: string;
  key?: string;
}
const upload = (who: string | undefined, o: UploadOpts) => {
  const form = multipartBody([
    {
      name: 'file',
      filename: o.name ?? 'proof.bin',
      contentType: o.declared ?? 'application/octet-stream',
      data: o.data,
    },
  ]);
  return app.inject({
    method: 'POST',
    url: '/api/v1/files',
    payload: form.payload,
    headers: {
      'content-type': form.contentType,
      ...(who ? { authorization: `Bearer ${who}` } : {}),
      ...(o.key ? { 'idempotency-key': o.key } : {}),
    },
  });
};
const view = (who: string | undefined, id: string, qs = '') =>
  app.inject({
    url: `/api/v1/files/${id}${qs}`,
    ...(who ? { headers: { authorization: `Bearer ${who}` } } : {}),
  });

interface FileRow {
  id: string;
  sha256: string;
  mime: string;
  size_bytes: string;
  path: string;
  original_name: string | null;
  created_by: string | null;
}
const fileRows = async () =>
  (await db!.admin.query(`SELECT * FROM files ORDER BY created_at, id`)).rows as FileRow[];
const rowOf = async (id: string) =>
  (await db!.admin.query(`SELECT * FROM files WHERE id = $1`, [id])).rows[0] as FileRow;
const storedBlobs = () =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && !e.parentPath.includes('.tmp'))
    .map((e) => join(e.parentPath, e.name));
const auditCount = async (action: string) =>
  Number(
    (
      (await db!.admin.query(`SELECT count(*) AS n FROM audit_log WHERE action = $1`, [action]))
        .rows[0] as {
        n: string;
      }
    ).n,
  );

async function uploadOk(who: string, o: UploadOpts) {
  const res = await upload(who, o);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as {
    id: string;
    sha256: string;
    mime: string;
    size_bytes: string;
    original_name: string | null;
    width: number | null;
    height: number | null;
  };
}

beforeAll(async () => {
  db = await createTestDb();
  if (!db) return;
  dir = mkdtempSync(join(tmpdir(), 'barakah-files-'));
  app = await buildApp({ env: { ...testEnv, FILES_DIR: dir }, db: db.app, clock });
  fund = await seedFund(db.admin);
  for (const code of ['M01', 'M02', 'M03', 'M04', 'M07'] as const) {
    token[code] = await activateAndLogin(app, db, clock, fund, code);
  }
}, 180_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function dbIt(name: string, fn: () => Promise<void>): void {
  it(name, async (ctx) => {
    if (!db) return ctx.skip();
    await fn();
  });
}

describe('POST /files: what gets stored', () => {
  dbIt('needs a login and a writable account', async () => {
    expect((await upload(undefined, { data: pdf() })).statusCode).toBe(401);
    await db!.admin.query(`UPDATE members SET status = 'suspended' WHERE id = $1`, [
      fund.members.M04,
    ]);
    try {
      const res = await upload(token.M04, { data: pdf() });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('auth.read_only');
    } finally {
      await db!.admin.query(`UPDATE members SET status = 'active' WHERE id = $1`, [
        fund.members.M04,
      ]);
    }
    expect(await fileRows()).toEqual([]);
  });

  dbIt(
    're-encodes a JPEG: EXIF is gone, orientation is applied, the sha256 names the stored bytes',
    async () => {
      const input = await jpegWithExif();
      const before = await sharp(input).metadata();
      expect(before.exif).toBeDefined(); // the sample really carries EXIF
      expect(input.includes('secret-owner-name')).toBe(true);

      const out = await uploadOk(token.M02, {
        name: 'receipt.jpg',
        data: input,
        declared: 'image/jpeg',
      });
      expect(out).toMatchObject({
        mime: 'image/jpeg',
        original_name: 'receipt.jpg',
        width: 100,
        height: 200,
      });

      const row = await rowOf(out.id);
      const stored = readFileSync(join(dir, row['path']));
      expect(row).toMatchObject({
        sha256: out.sha256,
        mime: 'image/jpeg',
        created_by: fund.users.M02,
        original_name: 'receipt.jpg',
      });
      expect(Number(row['size_bytes'])).toBe(stored.length);
      expect(out.size_bytes).toBe(String(stored.length));
      expect(sha(stored)).toBe(out.sha256);
      expect(row['path']).toBe(`${out.sha256.slice(0, 2)}/${out.sha256}`);

      expect(stored.includes('secret-owner-name')).toBe(false);
      expect(stored.includes('home gps')).toBe(false);
      const after = await sharp(stored).metadata();
      expect(after.exif).toBeUndefined();
      expect(after.orientation).toBeUndefined();
      expect([after.width, after.height]).toEqual([100, 200]); // rotated upright
    },
  );

  dbIt('accepts PNG and WebP and keeps their type', async () => {
    const a = await uploadOk(token.M02, { name: 'a.png', data: await png() });
    const b = await uploadOk(token.M02, { name: 'b.webp', data: await webp() });
    expect([a.mime, b.mime]).toEqual(['image/png', 'image/webp']);
    expect(a.width).toBe(40);
  });

  dbIt('scales very large images down', async () => {
    const out = await uploadOk(token.M02, {
      name: 'huge.jpg',
      data: await sharp({ create: { width: 6000, height: 3000, channels: 3, background: '#fff' } })
        .jpeg()
        .toBuffer(),
    });
    expect([out.width, out.height]).toEqual([4096, 2048]);
  });

  dbIt('stores a PDF exactly as sent', async () => {
    const input = pdf('keep every byte');
    const out = await uploadOk(token.M02, {
      name: 'deed.pdf',
      data: input,
      declared: 'application/pdf',
    });
    expect(out).toMatchObject({
      mime: 'application/pdf',
      width: null,
      height: null,
      sha256: sha(input),
    });
    expect(readFileSync(join(dir, (await rowOf(out.id))['path'])).equals(input)).toBe(true);
  });

  dbIt('decides the type from the bytes, not from the claimed type or the name', async () => {
    const asPng = await uploadOk(token.M02, {
      name: 'looks-like.png',
      data: pdf('spoof'),
      declared: 'image/png',
    });
    expect(asPng.mime).toBe('application/pdf');

    for (const [label, data] of [
      ['text', 'just some text'],
      ['html', '<script>alert(1)</script>'],
      ['gif', Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!')],
      ['windows executable', Buffer.from('MZ\x90\x00\x03\x00\x00\x00')],
    ] as const) {
      const res = await upload(token.M02, { name: 'photo.jpg', data, declared: 'image/jpeg' });
      expect(res.statusCode, label).toBe(415);
      expect(res.json().code, label).toBe('file.unsupported_type');
    }
  });

  dbIt('rejects an image that is damaged', async () => {
    const res = await upload(token.M02, {
      data: Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        Buffer.from('this is not a jpeg body'),
      ]),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('file.corrupt');
  });

  dbIt('enforces the 10 MB limit exactly', async () => {
    const atLimit = Buffer.concat([pdf(), Buffer.alloc(FILE_MAX_BYTES - pdf().length, 0x20)]);
    expect(atLimit.length).toBe(FILE_MAX_BYTES);
    expect((await upload(token.M02, { name: 'max.pdf', data: atLimit })).statusCode).toBe(201);

    const over = Buffer.concat([atLimit, Buffer.from(' ')]);
    const res = await upload(token.M02, { name: 'over.pdf', data: over });
    expect(res.statusCode).toBe(413);
    expect(res.json().code).toBe('file.too_large');

    const way = await upload(token.M02, {
      name: 'way.pdf',
      data: Buffer.alloc(FILE_MAX_BYTES + 1_500_000, 0x20),
    });
    expect(way.statusCode).toBe(413);
    expect(
      await fileRows().then((r) => r.filter((x) => x['original_name'] === 'over.pdf')),
    ).toEqual([]);
  });

  dbIt('rejects an empty file, a missing file part and a non-multipart request', async () => {
    const empty = await upload(token.M02, { data: '' });
    expect([empty.statusCode, empty.json().code]).toEqual([400, 'file.empty']);

    const noFile = multipartBody([{ name: 'note', data: 'hello' }]);
    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/files',
      payload: noFile.payload,
      headers: { authorization: `Bearer ${token.M02}`, 'content-type': noFile.contentType },
    });
    expect([missing.statusCode, missing.json().code]).toEqual([400, 'file.missing_part']);

    const json = await app.inject({
      method: 'POST',
      url: '/api/v1/files',
      payload: { file: 'x' },
      headers: { authorization: `Bearer ${token.M02}` },
    });
    expect([json.statusCode, json.json().code]).toEqual([400, 'file.not_multipart']);
  });

  dbIt('stores identical content once, but records every upload', async () => {
    const data = await png();
    const blobsBefore = storedBlobs().length;
    const first = await uploadOk(token.M02, { name: 'one.png', data });
    const second = await uploadOk(token.M03, { name: 'two.png', data });
    const third = await uploadOk(token.M03, { name: 'three.png', data });
    expect(new Set([first.sha256, second.sha256, third.sha256]).size).toBe(1);
    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
    expect(storedBlobs().length - blobsBefore).toBeLessThanOrEqual(2); // the blob and its thumbnail, at most once
    expect((await rowOf(second.id))['created_by']).toBe(fund.users.M03);
  });

  dbIt('keeps only a harmless display name and never uses it as a path', async () => {
    const traversal = await uploadOk(token.M02, { name: '../../etc/passwd', data: pdf('t1') });
    expect(traversal.original_name).toBe('passwd');
    const windows = await uploadOk(token.M02, { name: 'C:\\Users\\me\\scan.pdf', data: pdf('t2') });
    expect(windows.original_name).toBe('scan.pdf');
    const control = await uploadOk(token.M02, { name: 'a\u0007b\u0001.pdf', data: pdf('t3') });
    expect(control.original_name).toBe('ab.pdf');
    const dots = await uploadOk(token.M02, { name: '..', data: pdf('t4') });
    expect(dots.original_name).toBeNull();

    // Everything on disk sits at <2 hex>/<64 hex>[.thumb.jpg] under the root, nowhere else.
    for (const path of storedBlobs()) {
      expect(path.slice(dir.length + 1)).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{64}(\.thumb\.jpg)?$/);
    }
    expect(existsSync(join(dir, '..', 'passwd'))).toBe(false);
  });

  dbIt('writes an audit row per upload with the hash and type, not the bytes', async () => {
    const before = await auditCount('file.upload');
    const out = await uploadOk(token.M02, { name: 'audited.pdf', data: pdf('audit me') });
    expect(await auditCount('file.upload')).toBe(before + 1);
    const row = (
      await db!.admin.query(`SELECT actor_user_id, after FROM audit_log WHERE entity_id = $1`, [
        out.id,
      ])
    ).rows[0];
    expect(row).toMatchObject({
      actor_user_id: fund.users.M02,
      after: { sha256: out.sha256, mime: 'application/pdf', original_name: 'audited.pdf' },
    });
  });
});

describe('GET /files/:id: who can see what', () => {
  dbIt('needs a login; unknown ids are 404 and malformed ids are 400', async () => {
    const out = await uploadOk(token.M02, { name: 'x.pdf', data: pdf('auth') });
    expect((await view(undefined, out.id)).statusCode).toBe(401);
    const missing = await view(token.M02, randomUUID());
    expect([missing.statusCode, missing.json().code]).toEqual([404, 'file.not_found']);
    expect((await view(token.M02, 'not-a-uuid')).statusCode).toBe(400);
  });

  dbIt(
    'a file not yet attached to anything is for its uploader, the cashier and the auditor',
    async () => {
      const input = await png();
      const out = await uploadOk(token.M02, { name: 'draft.png', data: input });
      for (const who of [token.M02, token.M01, token.M07])
        expect((await view(who, out.id)).statusCode).toBe(200);
      const denied = await view(token.M03, out.id);
      expect([denied.statusCode, denied.json().code]).toEqual([403, 'auth.forbidden']);
    },
  );

  dbIt('serves the stored bytes with a safe download header', async () => {
    const out = await uploadOk(token.M02, { name: 'scan.png', data: await png() });
    const res = await view(token.M02, out.id);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(readFileSync(join(dir, (await rowOf(out.id))['path'])))).toBe(
      true,
    );
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-length']).toBe(out.size_bytes);
    expect(res.headers['content-disposition']).toBe(
      `inline; filename="scan.png"; filename*=UTF-8''scan.png`,
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');

    const doc = await uploadOk(token.M02, { name: 'রশিদ 1.pdf', data: pdf('bn') });
    const pdfRes = await view(token.M02, doc.id);
    expect(pdfRes.headers['content-type']).toBe('application/pdf');
    const disposition = String(pdfRes.headers['content-disposition']);
    expect(disposition.startsWith('attachment;')).toBe(true);
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent('রশিদ 1.pdf')}`);
    expect(disposition).not.toMatch(/filename="[^"]*[^\x20-\x7e][^"]*"/);
  });

  dbIt('makes a thumbnail for images only', async () => {
    const out = await uploadOk(token.M02, { name: 'big.jpg', data: await bigJpeg() });
    const full = await view(token.M02, out.id);
    const thumb = await view(token.M02, out.id, '?thumb=true');
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers['content-type']).toBe('image/jpeg');
    const meta = await sharp(thumb.rawPayload).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(THUMBNAIL_MAX_SIDE);
    expect(thumb.rawPayload.length).toBeLessThan(full.rawPayload.length);
    expect((await view(token.M02, out.id, '?thumb=false')).rawPayload.equals(full.rawPayload)).toBe(
      true,
    );

    const doc = await uploadOk(token.M02, { name: 'doc.pdf', data: pdf('nothumb') });
    const noThumb = await view(token.M02, doc.id, '?thumb=true');
    expect([noThumb.statusCode, noThumb.json().code]).toEqual([404, 'file.no_thumbnail']);
  });

  dbIt(
    'a file attached to the group records (photo, document) is visible to every member',
    async () => {
      const photo = await uploadOk(token.M02, { name: 'me.png', data: await webp() });
      expect((await view(token.M03, photo.id)).statusCode).toBe(403); // not attached yet
      const set = await app.inject({
        method: 'PATCH',
        url: '/api/v1/members/me',
        payload: { photo_file_id: photo.id },
        headers: { authorization: `Bearer ${token.M02}` },
      });
      expect(set.statusCode).toBe(200);
      expect((await view(token.M03, photo.id)).statusCode).toBe(200);

      const deed = await uploadOk(token.M01, { name: 'deed.pdf', data: pdf('deed') });
      await db!.admin.query(
        `INSERT INTO documents (file_id, entity_type, entity_id, doc_type) VALUES ($1, 'asset', $2, 'deed')`,
        [deed.id, randomUUID()],
      );
      expect((await view(token.M03, deed.id)).statusCode).toBe(200);
    },
  );

  dbIt(
    'a payment proof is for its payer, the cashier and the auditor, and every view is audited',
    async () => {
      const proof = await uploadOk(token.M02, {
        name: 'bkash-screenshot.png',
        data: await bigJpeg(),
      });
      const paymentId = await addConfirmedPayment(db!.admin, fund.members.M02, 500_000, {
        trxId: 'TRX-PROOF-1',
      });
      // A proof is attached when the payment is submitted; here we do it with the same insert shape.
      await db!.admin.query(
        `INSERT INTO payments (member_id, amount_paisa, method, paid_at, status, source, proof_file_id)
       VALUES ($1, 100000, 'bkash', now(), 'pending', 'member_submitted', $2)`,
        [fund.members.M02, proof.id],
      );
      expect(paymentId).toBeTruthy();

      const audited = await auditCount('file.view_proof');
      for (const who of [token.M02, token.M01, token.M07]) {
        expect((await view(who, proof.id)).statusCode).toBe(200);
      }
      expect((await view(token.M02, proof.id, '?thumb=true')).statusCode).toBe(200);
      expect(await auditCount('file.view_proof')).toBe(audited + 4);

      for (const who of [token.M03, token.M04]) {
        const res = await view(who, proof.id);
        expect([res.statusCode, res.json().code]).toEqual([403, 'auth.forbidden']);
        expect((await view(who, proof.id, '?thumb=true')).statusCode).toBe(403);
      }
      expect(await auditCount('file.view_proof')).toBe(audited + 4); // refused views leave no "viewed" row

      const last = (
        await db!.admin.query(
          `SELECT actor_user_id, entity_id FROM audit_log WHERE action = 'file.view_proof' ORDER BY id DESC LIMIT 1`,
        )
      ).rows[0];
      expect(last).toMatchObject({ actor_user_id: fund.users.M02, entity_id: proof.id });
    },
  );

  dbIt("a proof stays private even if the same file is also someone's photo", async () => {
    const out = await uploadOk(token.M03, { name: 'both.png', data: await png() });
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/members/me',
      payload: { photo_file_id: out.id },
      headers: { authorization: `Bearer ${token.M03}` },
    });
    expect((await view(token.M02, out.id)).statusCode).toBe(200); // a photo: everyone
    await db!.admin.query(
      `INSERT INTO payments (member_id, amount_paisa, method, paid_at, status, source, proof_file_id)
       VALUES ($1, 100000, 'nagad', now(), 'pending', 'member_submitted', $2)`,
      [fund.members.M03, out.id],
    );
    expect((await view(token.M02, out.id)).statusCode).toBe(403); // now it is a proof: payer only
    expect((await view(token.M03, out.id)).statusCode).toBe(200);
  });

  dbIt('opening ordinary files writes no audit row', async () => {
    const out = await uploadOk(token.M02, { name: 'plain.png', data: await png() });
    const before = await auditCount('file.view_proof');
    await view(token.M02, out.id);
    await view(token.M02, out.id, '?thumb=true');
    expect(await auditCount('file.view_proof')).toBe(before);
  });

  dbIt('reports a missing blob as a server error without revealing the path', async () => {
    const out = await uploadOk(token.M02, { name: 'gone.pdf', data: pdf('vanish') });
    rmSync(join(dir, (await rowOf(out.id))['path']));
    const res = await view(token.M02, out.id);
    expect([res.statusCode, res.json().code]).toEqual([500, 'file.missing']);
    expect(res.body).not.toContain(dir);
  });

  dbIt('files and their rows cannot be deleted by the application', async () => {
    await expect(db!.app.query(`DELETE FROM files`)).rejects.toThrow(/permission denied/);
    await expect(db!.admin.query(`DELETE FROM files`)).rejects.toThrow(/cannot be deleted/);
    expect(statSync(dir).isDirectory()).toBe(true);
  });
});

describe('upload rate limit', () => {
  dbIt(
    'stops a flood of uploads from one address, and reading files is not limited by it',
    async () => {
      const limited = await buildApp({
        env: { ...testEnv, FILES_DIR: dir, UPLOAD_RATE_LIMIT_PER_MINUTE: 3 },
        db: db!.app,
        clock,
      });
      try {
        const send = () => {
          const form = multipartBody([
            { name: 'file', filename: 'f.pdf', data: pdf(randomUUID()) },
          ]);
          return limited.inject({
            method: 'POST',
            url: '/api/v1/files',
            payload: form.payload,
            headers: { 'content-type': form.contentType, authorization: `Bearer ${token.M02}` },
          });
        };
        const statuses = [];
        for (let i = 0; i < 5; i++) statuses.push((await send()).statusCode);
        expect(statuses).toEqual([201, 201, 201, 429, 429]);
      } finally {
        await limited.close();
      }
    },
  );
});

describe('Idempotency-Key on POST /files', () => {
  const key = () => `key-${randomUUID()}`;
  const countNamed = async (name: string) =>
    (await fileRows()).filter((r) => r['original_name'] === name).length;

  dbIt('replays the original response for the same key and the same upload', async () => {
    const k = key();
    const data = await webp();
    const first = await upload(token.M02, { name: 'idem-a.webp', data, key: k });
    const again = await upload(token.M02, { name: 'idem-a.webp', data, key: k });
    expect([first.statusCode, again.statusCode]).toEqual([201, 201]);
    expect(first.headers['idempotent-replay']).toBeUndefined();
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect(await countNamed('idem-a.webp')).toBe(1);
    expect(await auditCount('file.upload')).toBeGreaterThan(0);
    const stored = (
      await db!.admin.query(
        `SELECT status_code, request_hash FROM idempotency_keys WHERE key = $1`,
        [k],
      )
    ).rows[0];
    expect(stored).toMatchObject({ status_code: 201 });
  });

  dbIt('without a key every request is its own upload', async () => {
    const data = pdf('no key');
    await uploadOk(token.M02, { name: 'idem-b.pdf', data });
    await uploadOk(token.M02, { name: 'idem-b.pdf', data });
    expect(await countNamed('idem-b.pdf')).toBe(2);
  });

  dbIt('refuses the same key for a different upload', async () => {
    const k = key();
    await uploadOk(token.M02, { name: 'idem-c.pdf', data: pdf('one'), key: k });
    const clash = await upload(token.M02, { name: 'idem-c.pdf', data: pdf('two'), key: k });
    expect([clash.statusCode, clash.json().code]).toEqual([422, 'idempotency.key_reuse']);
    const sameBytesOtherName = await upload(token.M02, {
      name: 'other.pdf',
      data: pdf('one'),
      key: k,
    });
    expect(sameBytesOtherName.statusCode).toBe(422);
    expect(await countNamed('idem-c.pdf')).toBe(1);
  });

  dbIt(
    'a key is private to its user: another member with the same key gets their own upload',
    async () => {
      const k = key();
      const data = pdf('shared key');
      const a = await upload(token.M02, { name: 'idem-d.pdf', data, key: k });
      const b = await upload(token.M03, { name: 'idem-d.pdf', data, key: k });
      expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
      expect(b.headers['idempotent-replay']).toBeUndefined();
      expect(b.json().id).not.toBe(a.json().id);
    },
  );

  dbIt('rejects a malformed key', async () => {
    for (const bad of ['short', 'has spaces in it!', 'x'.repeat(129)]) {
      const res = await upload(token.M02, { data: pdf('bad key'), key: bad });
      expect([res.statusCode, res.json().code], bad).toEqual([400, 'idempotency.invalid_key']);
    }
  });

  dbIt('simultaneous retries run the upload once', async () => {
    const k = key();
    const data = await png();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => upload(token.M02, { name: 'idem-e.png', data, key: k })),
    );
    expect(await countNamed('idem-e.png')).toBe(1);
    const created = results.filter((r) => r.statusCode === 201);
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.statusCode === 201 || r.statusCode === 409)).toBe(true);
    expect(new Set(created.map((r) => r.json().id)).size).toBe(1);
    for (const r of results.filter((x) => x.statusCode === 409)) {
      expect(r.json().code).toBe('idempotency.in_progress');
    }
  });

  dbIt('a failed request releases the key so the client can retry', async () => {
    const k = key();
    const bad = await upload(token.M02, { name: 'idem-f.txt', data: 'plain text', key: k });
    expect(bad.statusCode).toBe(415);
    const again = await upload(token.M02, { name: 'idem-f.txt', data: 'plain text', key: k });
    expect(again.statusCode).toBe(415); // runs again, is not "in progress"
    const fixed = await upload(token.M02, { name: 'idem-f.pdf', data: pdf('fixed'), key: k });
    expect(fixed.statusCode).toBe(201);
    expect(await countNamed('idem-f.pdf')).toBe(1);
  });

  dbIt('a key expires after 24 hours', async () => {
    const k = key();
    const data = pdf('expiring');
    const first = await upload(token.M02, { name: 'idem-g.pdf', data, key: k });
    clock.advance(23 * 3600_000);
    expect(
      (await upload(token.M02, { name: 'idem-g.pdf', data, key: k })).headers['idempotent-replay'],
    ).toBe('true');
    clock.advance(2 * 3600_000); // 25 h after the first request
    const later = await upload(token.M02, { name: 'idem-g.pdf', data, key: k });
    expect(later.statusCode).toBe(201);
    expect(later.headers['idempotent-replay']).toBeUndefined();
    expect(later.json().id).not.toBe(first.json().id);
    expect(await countNamed('idem-g.pdf')).toBe(2);
  });

  dbIt('takes over a request that crashed and left its placeholder behind', async () => {
    const k = key();
    await db!.admin.query(
      `INSERT INTO idempotency_keys (user_id, key, request_hash, response, status_code, created_at)
       VALUES ($1, $2, 'whatever', '{}', 0, $3)`,
      [fund.users.M02, k, new Date(clock.now().getTime() - 5 * 60_000)],
    );
    const res = await upload(token.M02, { name: 'idem-h.pdf', data: pdf('after crash'), key: k });
    expect(res.statusCode).toBe(201);
    expect(await countNamed('idem-h.pdf')).toBe(1);
  });
});
