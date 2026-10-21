import type { JobDeps } from '../index';
import { draftMonthlyMeeting, remindMeetings } from '../../meetings/service';
import { makeNotificationDeps } from './send';

/** Daily: draft this month's meeting from `meeting_window_start_day - 5` (Doc.md 18.7). */
export async function meetingDraftJob(deps: JobDeps): Promise<{ created: string | null }> {
  return draftMonthlyMeeting({ pool: deps.pool, clock: deps.clock });
}

/** Hourly: remind members a day and an hour before a scheduled meeting. */
export async function meetingRemindersJob(deps: JobDeps): Promise<{ queued: number }> {
  return remindMeetings({ pool: deps.pool, clock: deps.clock, notifications: makeNotificationDeps(deps) });
}
