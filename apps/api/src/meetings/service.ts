import type pg from 'pg';
import type { Clock, MeetingAttendance, MeetingSchedule, MeetingStatus, AttendanceStatus } from '@barakah/shared';
import { audit } from '../lib/audit';
import { badRequest, conflict, notFound } from '../lib/errors';
import { getRule, ruleInt, rulePaisa } from '../lib/rules';
import { inTransaction, type Db } from '../lib/tx';
import { fmtBn, fmtMonth, notifyMember, type NotificationDeps } from '../notifications/service';

/**
 * Monthly meetings (constitution 9, Doc.md 18.7). A job drafts next month's meeting, the cashier sets
 * the time and link, members are reminded a day and an hour before, and afterwards the cashier marks
 * attendance once. Marking attendance closes the meeting (status `held`) and is final: an absence fine
 * created from it is a financial record, so a mistake is corrected with a `fine_waiver` proposal.
 */

export interface MeetingDeps {
  pool: pg.Pool;
  clock: Clock;
}

export interface MeetingActor {
  userId: string;
  ip?: string;
  deviceId?: string | null;
}

export interface MeetingRow {
  id: string;
  status: MeetingStatus;
  /** Asia/Dhaka date and time, or null on a draft that has no time yet. */
  date: string | null;
  time: string | null;
  scheduled_for: string | null;
  link: string | null;
  notes: string | null;
  created_at: string;
  present_count: number;
  absent_count: number;
}

export interface AttendanceRow {
  member_id: string;
  member_code: string;
  member_name: string;
  status: AttendanceStatus | null;
  reason: string | null;
}

export interface MeetingDetail extends MeetingRow {
  /** Held: the recorded attendance. Otherwise: the members expected to attend (status null). */
  attendance: AttendanceRow[];
  absence_fines: Array<{ fine_id: string; member_id: string; amount_paisa: string }>;
}

const MEETING_COLUMNS = `
  m.id, m.status, m.link, m.notes, m.created_at, m.scheduled_for,
  to_char(m.scheduled_for AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM-DD') AS date,
  to_char(m.scheduled_for AT TIME ZONE 'Asia/Dhaka', 'HH24:MI') AS time,
  (SELECT count(*)::int FROM meeting_attendance a WHERE a.meeting_id = m.id AND a.status = 'present') AS present_count,
  (SELECT count(*)::int FROM meeting_attendance a WHERE a.meeting_id = m.id AND a.status <> 'present') AS absent_count`;

function toRow(r: Record<string, unknown>): MeetingRow {
  return {
    id: r.id as string,
    status: r.status as MeetingStatus,
    date: (r.date as string | null) ?? null,
    time: (r.time as string | null) ?? null,
    scheduled_for: r.scheduled_for ? new Date(r.scheduled_for as string).toISOString() : null,
    link: (r.link as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    created_at: new Date(r.created_at as string).toISOString(),
    present_count: r.present_count as number,
    absent_count: r.absent_count as number,
  };
}

/** Newest first: drafts and upcoming meetings on top, then past ones by date. */
export async function listMeetings(db: Db, limit = 50): Promise<MeetingRow[]> {
  const res = await db.query(
    `SELECT ${MEETING_COLUMNS} FROM meetings m
     ORDER BY (m.status = 'draft') DESC, m.scheduled_for DESC NULLS FIRST, m.created_at DESC
     LIMIT $1`,
    [limit],
  );
  return res.rows.map(toRow);
}

/** The next scheduled meeting that has not finished yet (shown on the member home page). */
export async function nextMeeting(db: Db, now: Date): Promise<MeetingRow | null> {
  const res = await db.query(
    `SELECT ${MEETING_COLUMNS} FROM meetings m
     WHERE m.status = 'scheduled' AND m.scheduled_for > $1::timestamptz - interval '3 hours'
     ORDER BY m.scheduled_for LIMIT 1`,
    [now],
  );
  return res.rows[0] ? toRow(res.rows[0] as Record<string, unknown>) : null;
}

export async function getMeeting(db: Db, id: string): Promise<MeetingDetail> {
  const res = await db.query(`SELECT ${MEETING_COLUMNS} FROM meetings m WHERE m.id = $1`, [id]);
  if (!res.rows[0]) throw notFound('meeting.not_found', 'Meeting not found');
  const meeting = toRow(res.rows[0] as Record<string, unknown>);

  const attendance =
    meeting.status === 'held'
      ? await db.query(
          `SELECT a.member_id, mb.code AS member_code, mb.full_name AS member_name, a.status, a.reason
           FROM meeting_attendance a JOIN members mb ON mb.id = a.member_id
           WHERE a.meeting_id = $1 ORDER BY mb.code`,
          [id],
        )
      : await db.query(
          `SELECT mb.id AS member_id, mb.code AS member_code, mb.full_name AS member_name, NULL AS status, NULL AS reason
           FROM members mb WHERE mb.status IN ('active','warning') ORDER BY mb.code`,
        );
  const fines = await db.query(
    `SELECT id AS fine_id, member_id, amount_paisa::text AS amount_paisa
     FROM fines WHERE meeting_id = $1 AND kind = 'absence' ORDER BY created_at`,
    [id],
  );
  return {
    ...meeting,
    attendance: attendance.rows as AttendanceRow[],
    absence_fines: fines.rows as MeetingDetail['absence_fines'],
  };
}

/** Lock the meeting row for a change; refuses a meeting in the wrong state. */
async function lockMeeting(tx: Db, id: string, allowed: MeetingStatus[]): Promise<{ status: MeetingStatus; scheduled_for: Date | null }> {
  const res = await tx.query(`SELECT status, scheduled_for FROM meetings WHERE id = $1 FOR UPDATE`, [id]);
  const row = res.rows[0] as { status: MeetingStatus; scheduled_for: Date | null } | undefined;
  if (!row) throw notFound('meeting.not_found', 'Meeting not found');
  if (!allowed.includes(row.status)) {
    throw conflict('meeting.wrong_status', `Meeting is ${row.status}`, { status: row.status });
  }
  return row;
}

export async function createMeeting(deps: MeetingDeps, actor: MeetingActor, input: MeetingSchedule): Promise<string> {
  return inTransaction(deps.pool, async (tx) => {
    const res = await tx.query(
      `INSERT INTO meetings (scheduled_for, link, notes, status)
       VALUES (($1::date + $2::time) AT TIME ZONE 'Asia/Dhaka', $3, $4, 'scheduled')
       RETURNING id`,
      [input.date, input.time, input.link ?? null, input.notes ?? null],
    );
    const id = (res.rows[0] as { id: string }).id;
    await audit(tx, {
      actor: actor.userId,
      action: 'meeting.create',
      entityType: 'meeting',
      entityId: id,
      after: input,
      ip: actor.ip,
      deviceId: actor.deviceId,
    });
    return id;
  });
}

/** Set or change the time, link and notes of a draft or scheduled meeting. */
export async function scheduleMeeting(deps: MeetingDeps, actor: MeetingActor, id: string, input: MeetingSchedule): Promise<void> {
  await inTransaction(deps.pool, async (tx) => {
    await lockMeeting(tx, id, ['draft', 'scheduled']);
    await tx.query(
      `UPDATE meetings
       SET scheduled_for = ($2::date + $3::time) AT TIME ZONE 'Asia/Dhaka', link = $4, notes = $5, status = 'scheduled'
       WHERE id = $1`,
      [id, input.date, input.time, input.link ?? null, input.notes ?? null],
    );
    await audit(tx, {
      actor: actor.userId,
      action: 'meeting.schedule',
      entityType: 'meeting',
      entityId: id,
      after: input,
      ip: actor.ip,
      deviceId: actor.deviceId,
    });
  });
}

export async function cancelMeeting(deps: MeetingDeps, actor: MeetingActor, id: string, reason?: string): Promise<void> {
  await inTransaction(deps.pool, async (tx) => {
    await lockMeeting(tx, id, ['draft', 'scheduled']);
    await tx.query(
      `UPDATE meetings SET status = 'cancelled',
         notes = CASE WHEN $2::text IS NULL THEN notes ELSE concat_ws(E'\\n', notes, $2::text) END
       WHERE id = $1`,
      [id, reason ?? null],
    );
    await audit(tx, {
      actor: actor.userId,
      action: 'meeting.cancel',
      entityType: 'meeting',
      entityId: id,
      after: { reason: reason ?? null },
      ip: actor.ip,
      deviceId: actor.deviceId,
    });
  });
}

/**
 * How many held meetings in a row, ending with the newest, the member missed without leave. Meetings
 * where the member was not marked (not yet a member, say) are skipped, not counted as a break.
 */
async function unexcusedStreak(tx: Db, memberId: string): Promise<number> {
  const res = await tx.query(
    `SELECT a.status FROM meeting_attendance a JOIN meetings m ON m.id = a.meeting_id
     WHERE a.member_id = $1 AND m.status = 'held'
     ORDER BY m.scheduled_for DESC`,
    [memberId],
  );
  let streak = 0;
  for (const row of res.rows as Array<{ status: AttendanceStatus }>) {
    if (row.status !== 'absent_unexcused') break;
    streak += 1;
  }
  return streak;
}

/**
 * Record attendance once, after the meeting, and close it. Each time a member's run of unexcused
 * absences reaches a multiple of `absence_fine_after_consecutive` (3, 6, ...), one absence fine of
 * `absence_fine_paisa` is created for this meeting (charity money, 18.2) and the member is told.
 */
export async function recordAttendance(
  deps: MeetingDeps & { notifications: NotificationDeps },
  actor: MeetingActor,
  id: string,
  input: MeetingAttendance,
): Promise<{ fines: Array<{ fine_id: string; member_id: string; amount_paisa: bigint }> }> {
  return inTransaction(deps.pool, async (tx) => {
    const meeting = await lockMeeting(tx, id, ['scheduled']);
    if (!meeting.scheduled_for || new Date(meeting.scheduled_for) > deps.clock.now()) {
      throw badRequest('meeting.not_started', 'Attendance can be marked only after the meeting has started');
    }
    const ids = input.items.map((i) => i.member_id);
    if (new Set(ids).size !== ids.length) throw badRequest('meeting.duplicate_member', 'A member is listed twice');
    const known = await tx.query(`SELECT count(*)::int AS n FROM members WHERE id = ANY($1::uuid[])`, [ids]);
    if ((known.rows[0] as { n: number }).n !== ids.length) throw notFound('member.not_found', 'Member not found');

    for (const item of input.items) {
      await tx.query(
        `INSERT INTO meeting_attendance (meeting_id, member_id, status, reason) VALUES ($1, $2, $3, $4)`,
        [id, item.member_id, item.status, item.reason ?? null],
      );
    }
    await tx.query(`UPDATE meetings SET status = 'held' WHERE id = $1`, [id]);

    // The rules in force on the meeting's own date.
    const asOf = (await tx.query(`SELECT to_char($1::timestamptz AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM-DD') AS d`, [meeting.scheduled_for]))
      .rows[0] as { d: string };
    const fines: Array<{ fine_id: string; member_id: string; amount_paisa: bigint }> = [];
    const hasRules = (await getRule(tx, 'absence_fine_paisa', asOf.d)) && (await getRule(tx, 'absence_fine_after_consecutive', asOf.d));
    if (hasRules) {
      const after = await ruleInt(tx, 'absence_fine_after_consecutive', asOf.d);
      const amount = await rulePaisa(tx, 'absence_fine_paisa', asOf.d);
      for (const item of input.items) {
        if (item.status !== 'absent_unexcused' || after <= 0 || amount <= 0n) continue;
        const streak = await unexcusedStreak(tx, item.member_id);
        if (streak === 0 || streak % after !== 0) continue;
        const res = await tx.query(
          `INSERT INTO fines (member_id, kind, meeting_id, amount_paisa, reason)
           VALUES ($1, 'absence', $2, $3::bigint, 'absence') RETURNING id`,
          [item.member_id, id, amount.toString()],
        );
        const fineId = (res.rows[0] as { id: string }).id;
        fines.push({ fine_id: fineId, member_id: item.member_id, amount_paisa: amount });
        const name = (await tx.query(`SELECT full_name FROM members WHERE id = $1`, [item.member_id])).rows[0] as { full_name: string };
        await notifyMember(deps.notifications, tx, {
          memberId: item.member_id,
          template: 'absence_fine',
          vars: { name: name.full_name, count: fmtBnCount(streak), amount: fmtBn(amount) },
          dedupeLabel: fineId,
        });
      }
    }

    await audit(tx, {
      actor: actor.userId,
      action: 'meeting.attendance',
      entityType: 'meeting',
      entityId: id,
      after: {
        present: input.items.filter((i) => i.status === 'present').length,
        absent_excused: input.items.filter((i) => i.status === 'absent_excused').length,
        absent_unexcused: input.items.filter((i) => i.status === 'absent_unexcused').length,
        fines: fines.map((f) => ({ fine_id: f.fine_id, amount_paisa: f.amount_paisa.toString() })),
      },
      ip: actor.ip,
      deviceId: actor.deviceId,
    });
    return { fines };
  });
}

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const fmtBnCount = (n: number | string) => String(n).replace(/\d/g, (d) => BN_DIGITS[Number(d)]!);
/** "2026-11-10" as "১০ নভেম্বর" for the reminder text. */
const bnDate = (date: string) => `${fmtBnCount(Number(date.slice(8, 10)))} ${fmtMonth(date.slice(0, 7)).split(' ')[0]}`;

/**
 * Daily job: from `meeting_window_start_day - 5` on, make sure this month has a meeting, creating an
 * empty draft for the cashier to fill in when there is none. Idempotent: an open draft, or any meeting this month, stops another.
 */
export async function draftMonthlyMeeting(deps: MeetingDeps): Promise<{ created: string | null }> {
  const today = deps.clock.todayDhaka();
  const startDay = await ruleInt(deps.pool, 'meeting_window_start_day', today);
  const day = Number(today.slice(8, 10));
  if (day < Math.max(1, startDay - 5)) return { created: null };
  const month = today.slice(0, 7);
  return inTransaction(deps.pool, async (tx) => {
    // one draft per month even if two runs overlap
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('meeting-draft'))`);
    const exists = await tx.query(
      `SELECT 1 FROM meetings
       WHERE status = 'draft'
          OR (status <> 'cancelled' AND to_char(scheduled_for AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM') = $1)
       LIMIT 1`,
      [month],
    );
    if ((exists.rowCount ?? 0) > 0) return { created: null };
    const res = await tx.query(`INSERT INTO meetings (status) VALUES ('draft') RETURNING id`);
    const id = (res.rows[0] as { id: string }).id;
    await audit(tx, { actor: null, action: 'meeting.draft', entityType: 'meeting', entityId: id, after: { month } });
    return { created: id };
  });
}

/**
 * Hourly job: remind every active member a day before and an hour before each scheduled meeting.
 * The dedupe label carries the meeting time, so a rescheduled meeting is reminded again.
 */
export async function remindMeetings(deps: MeetingDeps & { notifications: NotificationDeps }): Promise<{ queued: number }> {
  const now = deps.clock.now();
  const res = await deps.pool.query(
    `SELECT ${MEETING_COLUMNS} FROM meetings m
     WHERE m.status = 'scheduled' AND m.scheduled_for > $1 AND m.scheduled_for <= $1::timestamptz + interval '24 hours'`,
    [now],
  );
  const meetings = res.rows.map(toRow);
  if (meetings.length === 0) return { queued: 0 };
  const members = await deps.pool.query(`SELECT id FROM members WHERE status IN ('active','warning')`);
  let queued = 0;
  for (const m of meetings) {
    const minutesLeft = (new Date(m.scheduled_for!).getTime() - now.getTime()) / 60_000;
    const which = minutesLeft <= 60 ? 'hour' : 'day';
    for (const row of members.rows as Array<{ id: string }>) {
      const ids = await notifyMember(deps.notifications, deps.pool, {
        memberId: row.id,
        template: 'meeting_reminder',
        vars: { date: bnDate(m.date!), time: fmtBnCount(m.time!) },
        dedupeLabel: `${m.id}:${m.scheduled_for}:${which}`,
      });
      queued += ids.length;
    }
  }
  return { queued };
}
