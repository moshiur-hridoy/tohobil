import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, api, setAccessToken, setRefresher } from './api';

export interface Me {
  id: string;
  member_id: string;
  member_code: string;
  full_name: string;
  roles: string[];
  member_status: string;
  read_only: boolean;
  totp_enabled: boolean;
  step_up_until: string | null;
  device_id: string;
}

interface Session {
  access_token: string;
  refresh_token: string;
  device_id: string;
}

/**
 * Persistent identity of this install. The refresh token lives in localStorage for the PWA; the
 * Android build moves it to secure storage (Phase 2). Clearing browser data means asking the
 * cashier for a new activation code (spec 19.1).
 */
const KEYS = {
  device: 'barakah.device_id',
  install: 'barakah.install_id',
  refresh: 'barakah.refresh_token',
  ref: 'barakah.member_ref',
} as const;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private mode: the session simply will not survive a reload.
  }
}

function installId(): string {
  let id = read(KEYS.install);
  if (!id) {
    id = crypto.randomUUID();
    write(KEYS.install, id);
  }
  return id;
}

let inflightRefresh: Promise<boolean> | null = null;

type Status = 'loading' | 'anonymous' | 'authenticated';

interface AuthContextValue {
  status: Status;
  me: Me | null;
  /** Member reference remembered on this device (e.g. "M03"), for the PIN screen. */
  memberRef: string | null;
  /** True when this install has a registered device and can sign in with a PIN. */
  hasDevice: boolean;
  activate(input: { member_ref: string; code: string; pin: string }): Promise<void>;
  /** Member ID + PIN from any device; `member_ref` overrides the remembered one. */
  login(pin: string, member_ref?: string): Promise<void>;
  logout(): Promise<void>;
  /** Forget this device locally (after "device reset needed") so the activation screen opens. */
  forgetDevice(): void;
  refreshMe(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [memberRef, setMemberRef] = useState<string | null>(() => read(KEYS.ref));
  const [deviceId, setDeviceId] = useState<string | null>(() => read(KEYS.device));

  const loadMe = useCallback(async () => {
    setMe(await api<Me>('/me'));
    setStatus('authenticated');
  }, []);

  const applySession = useCallback((s: Session) => {
    setAccessToken(s.access_token);
    write(KEYS.refresh, s.refresh_token);
    write(KEYS.device, s.device_id);
    setDeviceId(s.device_id);
  }, []);

  const clearSession = useCallback(() => {
    setAccessToken(null);
    write(KEYS.refresh, null);
    setMe(null);
    setStatus('anonymous');
  }, []);

  const refreshSession = useCallback((): Promise<boolean> => {
    // Single flight: the refresh token rotates on every use and a replayed one revokes the device.
    // React StrictMode runs the boot effect twice in development, which would send the same token
    // twice and log the user out on every reload.
    inflightRefresh ??= doRefresh().finally(() => {
      inflightRefresh = null;
    });
    return inflightRefresh;

    async function doRefresh(): Promise<boolean> {
      const refresh_token = read(KEYS.refresh);
      const device_id = read(KEYS.device);
      if (!refresh_token || !device_id) return false;
      try {
        applySession(
          await api<Session>('/auth/refresh', {
            method: 'POST',
            auth: false,
            body: { refresh_token, device_id },
          }),
        );
        return true;
      } catch (err) {
        // A revoked device must not keep a stale id around: the login screen explains what to do.
        if (!(err instanceof ApiError && err.status === 0)) write(KEYS.refresh, null);
        return false;
      }
    }
  }, [applySession]);

  // Boot: resume the session from the stored refresh token, if any.
  useEffect(() => {
    setRefresher(refreshSession);
    let cancelled = false;
    void (async () => {
      if (await refreshSession()) {
        try {
          await loadMe();
          return;
        } catch {
          /* fall through to anonymous */
        }
      }
      if (!cancelled) setStatus('anonymous');
    })();
    return () => {
      cancelled = true;
      setRefresher(null);
    };
  }, [refreshSession, loadMe]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      me,
      memberRef,
      hasDevice: deviceId !== null,
      async activate({ member_ref, code, pin }) {
        const ua = navigator.userAgent;
        const session = await api<Session>('/auth/activate', {
          method: 'POST',
          auth: false,
          body: {
            member_ref,
            code,
            pin,
            device: {
              label: /Android/i.test(ua) ? 'Android browser' : 'Web browser',
              platform: 'web',
              install_id: installId(),
            },
          },
        });
        applySession(session);
        write(KEYS.ref, member_ref.trim().toUpperCase());
        setMemberRef(member_ref.trim().toUpperCase());
        await loadMe();
      },
      async login(pin, refOverride) {
        const member_ref = (refOverride ?? read(KEYS.ref))?.trim().toUpperCase();
        if (!member_ref) throw new ApiError(401, 'auth.invalid_credentials', 'No member ID');
        // A stored device id resumes that device; otherwise the server registers this one.
        const device_id = refOverride && refOverride.trim().toUpperCase() !== read(KEYS.ref) ? null : read(KEYS.device);
        const ua = navigator.userAgent;
        applySession(
          await api<Session>('/auth/login', {
            method: 'POST',
            auth: false,
            body: {
              member_ref,
              pin,
              ...(device_id ? { device_id } : {}),
              device: {
                label: /Android/i.test(ua) ? 'Android browser' : 'Web browser',
                platform: 'web',
                install_id: installId(),
              },
            },
          }),
        );
        write(KEYS.ref, member_ref);
        setMemberRef(member_ref);
        await loadMe();
      },
      async logout() {
        await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
        clearSession();
      },
      forgetDevice() {
        write(KEYS.device, null);
        write(KEYS.ref, null);
        setDeviceId(null);
        setMemberRef(null);
        clearSession();
      },
      refreshMe: loadMe,
    }),
    [status, me, memberRef, deviceId, applySession, clearSession, loadMe],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
