import { describe, expect, it } from 'vitest';
import { deviceRegisterSchema } from '@barakah/shared';
import { RoutingPushSender, type PushSender } from './push';

const recorder = (calls: string[][], ok: boolean): PushSender => ({
  send: async (tokens) => {
    calls.push(tokens);
    return tokens.map(() => ({ ok }));
  },
});

describe('RoutingPushSender', () => {
  it('sends browser subscriptions to the web sender and the rest to FCM, keeping the order', async () => {
    const nativeCalls: string[][] = [];
    const webCalls: string[][] = [];
    const sender = new RoutingPushSender(recorder(nativeCalls, true), recorder(webCalls, false));
    const res = await sender.send(['fcm-1', '{"endpoint":"x"}', 'fcm-2'], 'T', 'B');
    expect(nativeCalls).toEqual([['fcm-1', 'fcm-2']]);
    expect(webCalls).toEqual([['{"endpoint":"x"}']]);
    expect(res.map((r) => r.ok)).toEqual([true, false, true]);
  });

  it('fails browser tokens cleanly when browser push is not configured', async () => {
    const sender = new RoutingPushSender(recorder([], true), undefined);
    const res = await sender.send(['{"endpoint":"x"}'], undefined, 'B');
    expect(res[0]).toMatchObject({ ok: false });
  });
});

describe('web push subscription schema', () => {
  const keys = { p256dh: 'a', auth: 'b' };
  it('accepts the big push services and rejects other hosts', () => {
    const ok = deviceRegisterSchema.safeParse({ web_push: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys } });
    expect(ok.success).toBe(true);
    for (const endpoint of ['http://fcm.googleapis.com/x', 'https://evil.example.com/x', 'https://127.0.0.1/x', 'nope']) {
      expect(deviceRegisterSchema.safeParse({ web_push: { endpoint, keys } }).success).toBe(false);
    }
  });
});
