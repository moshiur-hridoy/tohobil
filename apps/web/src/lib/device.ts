import type { TFunction } from 'i18next';

/** The kinds of system a device label can name; each has a Bengali name under `devices.os.*`. */
const SYSTEMS = ['Android', 'iPhone', 'iPad', 'Windows', 'Mac', 'Linux'] as const;
type System = (typeof SYSTEMS)[number];

/** Labels written by app versions before 1.9, which only knew "Android or not". */
const OLD_LABELS: Record<string, string> = {
  'Android browser': 'devices.old.android',
  'Web browser': 'devices.old.web',
};

/**
 * The label stored for a new device: "Android · Chrome", "iPhone · Safari", "Windows · Edge".
 * Stored in English so it stays the same whatever language the member uses; shown via `deviceName`.
 */
export function deviceLabel(ua: string): string {
  const system: System | null = /Android/i.test(ua)
    ? 'Android'
    : /iPhone|iPod/i.test(ua)
      ? 'iPhone'
      : /iPad/i.test(ua)
        ? 'iPad'
        : /Windows/i.test(ua)
          ? 'Windows'
          : /Macintosh|Mac OS X/i.test(ua)
            ? 'Mac'
            : /Linux|CrOS/i.test(ua)
              ? 'Linux'
              : null;
  // Order matters: Edge, Opera and Samsung Internet also say "Chrome", and Chrome also says "Safari".
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /SamsungBrowser/.test(ua)
        ? 'Samsung Internet'
        : /Firefox|FxiOS/.test(ua)
          ? 'Firefox'
          : /Chrome|CriOS/.test(ua)
            ? 'Chrome'
            : /Safari/.test(ua)
              ? 'Safari'
              : null;
  return [system ?? 'Web', browser].filter(Boolean).join(' · ');
}

/** A device's name for the screen: "অ্যান্ড্রয়েড ফোন · Chrome". Browser names stay as brands. */
export function deviceName(t: TFunction, label: string | null, platform: string): string {
  if (platform === 'android' && !label) return t('devices.os.androidApp');
  if (!label) return t('devices.old.web');
  const old = OLD_LABELS[label];
  if (old) return t(old);
  const [first, ...rest] = label.split(' · ');
  const system = SYSTEMS.find((s) => s === first);
  if (!system && first !== 'Web') return label;
  return [t(system ? `devices.os.${system}` : 'devices.old.web'), ...rest].join(' · ');
}

/** Phone or computer, for the icon beside the name. */
export function isPhone(label: string | null, platform: string): boolean {
  return platform !== 'web' || /Android|iPhone|iPad/.test(label ?? '');
}
