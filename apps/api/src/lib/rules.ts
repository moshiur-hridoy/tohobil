import { AppError } from './errors';
import { toBigInt } from './money';
import type { Db } from './tx';

/**
 * Rule lookup by date (spec 5.2). `rules` rows are append-only: a change inserts a new row with a
 * later `valid_from`, and the value in force on a date is the row with the greatest
 * `valid_from <= date`. Every caller passes the business date the rule is *for*, never "now", so a
 * change never rewrites history.
 *
 * Values are raw jsonb. Seeded paisa rules are JSON numbers (`500000`); a rule written by a proposal
 * may carry the digit-string form used for money in payloads (`"500000"`), so the paisa reader
 * accepts both.
 */

export interface RuleRow {
  key: string;
  value: unknown;
  valid_from: string;
  clause_ref: string | null;
}

const RULE_COLUMNS = `key, value, valid_from::text AS valid_from, clause_ref`;

/** The rule in force on `asOf` (YYYY-MM-DD), or null when none has started yet. */
export async function getRule(db: Db, key: string, asOf: string): Promise<RuleRow | null> {
  const res = await db.query(
    `SELECT ${RULE_COLUMNS} FROM rules
     WHERE key = $1 AND valid_from <= $2::date
     ORDER BY valid_from DESC LIMIT 1`,
    [key, asOf],
  );
  return (res.rows[0] as RuleRow | undefined) ?? null;
}

/** Like `getRule`, but a missing rule is a server error: the system cannot guess a money rule. */
export async function requireRule(db: Db, key: string, asOf: string): Promise<RuleRow> {
  const rule = await getRule(db, key, asOf);
  if (!rule) throw new AppError(500, 'rule.missing', `Rule ${key} has no value on ${asOf}`);
  return rule;
}

const invalid = (key: string, expected: string) =>
  new AppError(500, 'rule.invalid', `Rule ${key} is not ${expected}`);

export async function ruleInt(db: Db, key: string, asOf: string): Promise<number> {
  const { value } = await requireRule(db, key, asOf);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d{1,15}$/.test(value)) return Number(value);
  throw invalid(key, 'an integer');
}

/** A non-negative paisa amount as bigint. */
export async function rulePaisa(db: Db, key: string, asOf: string): Promise<bigint> {
  const { value } = await requireRule(db, key, asOf);
  if (
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === 'string' && /^\d{1,18}$/.test(value))
  ) {
    return toBigInt(value);
  }
  throw invalid(key, 'a paisa amount');
}

export async function ruleString(db: Db, key: string, asOf: string): Promise<string> {
  const { value } = await requireRule(db, key, asOf);
  if (typeof value === 'string') return value;
  throw invalid(key, 'a string');
}

export async function ruleBool(db: Db, key: string, asOf: string): Promise<boolean> {
  const { value } = await requireRule(db, key, asOf);
  if (typeof value === 'boolean') return value;
  throw invalid(key, 'a boolean');
}

export interface FundTerm {
  start: string | null;
  end: string | null;
}

/**
 * The fund's term (constitution 1.2): `fund_term_start` and `fund_term_end`, as dates. A missing rule
 * is `null`, meaning no limit on that side.
 */
export async function fundTerm(db: Db, asOf: string): Promise<FundTerm> {
  const [start, end] = await Promise.all([
    getRule(db, 'fund_term_start', asOf),
    getRule(db, 'fund_term_end', asOf),
  ]);
  const asDate = (rule: RuleRow | null): string | null =>
    typeof rule?.value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rule.value) ? rule.value : null;
  return { start: asDate(start), end: asDate(end) };
}

/** Every rule in force on `asOf`, one row per key. */
export async function listRulesInForce(db: Db, asOf: string, key?: string): Promise<RuleRow[]> {
  const res = await db.query(
    `SELECT DISTINCT ON (key) ${RULE_COLUMNS} FROM rules
     WHERE valid_from <= $1::date AND ($2::text IS NULL OR key = $2)
     ORDER BY key, valid_from DESC`,
    [asOf, key ?? null],
  );
  return res.rows as RuleRow[];
}

/** Every version of every rule (or of one key), newest first within a key. */
export async function listRuleHistory(db: Db, key?: string): Promise<RuleRow[]> {
  const res = await db.query(
    `SELECT ${RULE_COLUMNS} FROM rules WHERE ($1::text IS NULL OR key = $1)
     ORDER BY key, valid_from DESC`,
    [key ?? null],
  );
  return res.rows as RuleRow[];
}
