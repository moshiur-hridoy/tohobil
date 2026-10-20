/** Every pg-boss queue the scheduler works. `pnpm migrate` creates them as the owning role. */
export const JOB_QUEUES = [
  'send-notifications',
  'finalize-proposals',
  'member-status',
  'generate-dues',
  'apply-fines',
  'remind-dues',
  'notify-fines',
  'pending-payment-alert',
  'cleanup',
  'sms-fallback',
  'generate-rent-expected',
] as const;
