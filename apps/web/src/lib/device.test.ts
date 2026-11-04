import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { deviceLabel, deviceName, isPhone } from './device';

const UA = {
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1',
  windowsEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0',
};

describe('deviceLabel', () => {
  it('names the system and the browser', () => {
    expect(deviceLabel(UA.androidChrome)).toBe('Android · Chrome');
    expect(deviceLabel(UA.samsung)).toBe('Android · Samsung Internet');
    expect(deviceLabel(UA.iphone)).toBe('iPhone · Safari');
    expect(deviceLabel(UA.iphoneChrome)).toBe('iPhone · Chrome');
    expect(deviceLabel(UA.windowsEdge)).toBe('Windows · Edge');
    expect(deviceLabel(UA.macSafari)).toBe('Mac · Safari');
    expect(deviceLabel(UA.linuxFirefox)).toBe('Linux · Firefox');
  });

  it('falls back to "Web" when nothing is recognised', () => {
    expect(deviceLabel('curl/8.0')).toBe('Web');
  });
});

describe('deviceName', () => {
  const t = ((key: string) => `<${key}>`) as unknown as TFunction;

  it('translates the system and keeps the browser brand', () => {
    expect(deviceName(t, 'Android · Chrome', 'web')).toBe('<devices.os.Android> · Chrome');
    expect(deviceName(t, 'Web', 'web')).toBe('<devices.old.web>');
  });

  it('translates the labels older versions wrote', () => {
    expect(deviceName(t, 'Android browser', 'web')).toBe('<devices.old.android>');
    expect(deviceName(t, 'Web browser', 'web')).toBe('<devices.old.web>');
  });

  it('shows any other label as it is', () => {
    expect(deviceName(t, 'Karim’s tablet', 'web')).toBe('Karim’s tablet');
  });

  it('tells phones from computers', () => {
    expect(isPhone('Android browser', 'web')).toBe(true);
    expect(isPhone('iPhone · Safari', 'web')).toBe(true);
    expect(isPhone('Windows · Edge', 'web')).toBe(false);
    expect(isPhone(null, 'android')).toBe(true);
  });
});
