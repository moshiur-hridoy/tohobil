import type pg from 'pg';

export interface SettingsService {
  getAppVersion(): Promise<{ min: string; latest: string; download_url: string }>;
  getString(key: string, defaultValue: string): Promise<string>;
  getBoolean(key: string, defaultValue: boolean): Promise<boolean>;
}

export function createSettingsService(pool: pg.Pool, defaults: {
  min: string;
  latest: string;
  downloadUrl: string;
}): SettingsService {
  async function getValue(key: string): Promise<unknown | undefined> {
    const res = await pool.query(`SELECT value FROM settings WHERE key = $1`, [key]);
    return (res.rows[0] as { value: unknown } | undefined)?.value;
  }

  return {
    async getAppVersion(): Promise<{ min: string; latest: string; download_url: string }> {
      const min = await getValue('app_min_version');
      const latest = await getValue('app_latest_version');
      const url = await getValue('apk_download_url');
      return {
        min: typeof min === 'string' && /^\d+\.\d+\.\d+$/.test(min) ? min : defaults.min,
        latest: typeof latest === 'string' && /^\d+\.\d+\.\d+$/.test(latest) ? latest : defaults.latest,
        download_url: typeof url === 'string' && url ? url : defaults.downloadUrl,
      };
    },
    async getString(key, defaultValue) {
      const v = await getValue(key);
      return typeof v === 'string' ? v : defaultValue;
    },
    async getBoolean(key, defaultValue) {
      const v = await getValue(key);
      if (typeof v === 'boolean') return v;
      if (typeof v === 'string') return v.toLowerCase() === 'true';
      return defaultValue;
    },
  };
}
