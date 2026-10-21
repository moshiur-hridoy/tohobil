import { z } from 'zod';
import { dateSchema, uuidSchema } from './common';

export const MEETING_STATUSES = ['draft', 'scheduled', 'held', 'cancelled'] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export const ATTENDANCE_STATUSES = ['present', 'absent_excused', 'absent_unexcused'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

/** A Dhaka wall-clock time, "HH:MM" (24-hour). */
export const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM');

const linkSchema = z.string().trim().url().max(500);

/** Create a meeting, or set its time on a draft. Date and time are Asia/Dhaka. */
export const meetingScheduleSchema = z.object({
  date: dateSchema,
  time: timeOfDaySchema,
  link: linkSchema.optional(),
  notes: z.string().trim().max(2000).optional(),
});

export type MeetingSchedule = z.infer<typeof meetingScheduleSchema>;

export const meetingCancelSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

/** Close a held meeting: one row per member who was expected. */
export const meetingAttendanceSchema = z.object({
  items: z
    .array(
      z.object({
        member_id: uuidSchema,
        status: z.enum(ATTENDANCE_STATUSES),
        reason: z.string().trim().max(500).optional(),
      }),
    )
    .min(1)
    .max(500),
});

export type MeetingAttendance = z.infer<typeof meetingAttendanceSchema>;
