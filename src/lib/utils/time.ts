/**
 * Time interval constants in milliseconds.
 *
 * Use these instead of hand-multiplied magic numbers like `1000 * 60 * 60 * 24`
 * for any code that deals with millisecond durations (timers, cache TTLs,
 * timestamp arithmetic, etc).
 *
 * `MS_PER_MONTH_30` is a 30-day approximation — not calendar-correct.
 * For real calendar math (variable-length months, DST), use date-fns.
 */

const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;
const MS_PER_WEEK = 7 * MS_PER_DAY;
const MS_PER_MONTH_30 = 30 * MS_PER_DAY;
