import pino from 'pino';

/**
 * Create the pino logger (JSON to stdout, spec 4). Secrets are redacted by path; phone numbers must
 * be passed through maskPhone() before they are logged. Never log OTPs, PINs, tokens or SMS bodies.
 */
export function createLogger(level: string = process.env.LOG_LEVEL ?? 'info'): pino.Logger {
  return pino({
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'headers.authorization',
        'headers.cookie',
        '*.phone',
        '*.pin',
        '*.otp',
        '*.token',
        '*.refresh_token',
        '*.access_token',
        '*.code',
        '*.password',
        '*.raw_sms',
        '*.body',
      ],
      censor: '[REDACTED]',
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

/**
 * Mask a phone number for logging: +8801712345678 -> +88017****5678
 */
export function maskPhone(phone: string): string {
  if (phone.length < 10) return '***';
  return phone.slice(0, 6) + '****' + phone.slice(-4);
}
