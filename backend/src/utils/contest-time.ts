// 比赛时间解析与状态计算的共享工具(contests.ts / submissions.ts 共用)

// Parse contest time strings into millisecond timestamps in a timezone-safe way.
// Handles DB time formats like "YYYY-MM-DD HH:MM:SS" (treated as UTC)
export function parseContestTimeToMs(t: any): number {
  if (!t) return NaN;
  let s = String(t);
  // If format is like "2024-01-01 12:00:00" (no timezone), treat as UTC by converting to ISO-like with Z
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    s = s.replace(' ', 'T') + 'Z';
  }
  // Otherwise rely on JS Date parsing (ISO strings with timezone will work)
  return new Date(s).getTime();
}

// 按当前时间动态计算比赛状态(不依赖可能过期的 contest.status 静态字段)
export function effectiveContestStatus(contest: any): 'upcoming' | 'running' | 'ended' {
  const now = Date.now();
  const start = parseContestTimeToMs(contest.start_time);
  const end = parseContestTimeToMs(contest.end_time);
  if (!isFinite(start) || !isFinite(end)) return 'upcoming';
  if (now >= start && now < end) return 'running';
  if (now >= end) return 'ended';
  return 'upcoming';
}
