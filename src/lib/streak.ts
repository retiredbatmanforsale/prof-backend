/**
 * Pure streak computation, no I/O.
 *
 * Lives outside the route handler so the day-rollover / freeze /
 * milestone math is unit-testable in isolation against a static
 * "now" parameter — no clock mocking required.
 *
 * Day keys are `YYYY-MM-DD` in UTC. Frontend used local timezone;
 * server-side UTC is the deliberate trade per STREAK_BACKEND_PLAN.md
 * (consistent across devices > matching local midnight).
 */

export type ActivitySource = "lesson" | "quiz" | "practice" | "tutor";

export type TodayActivity = {
  source: ActivitySource;
  label: string;
  timestamp: number;
};

export type StreakState = {
  currentStreak: number;
  longestStreak: number;
  totalActiveDays: number;
  freezesAvailable: number;
  /** YYYY-MM-DD or null if never active. */
  lastActiveDay: string | null;
  todayActivities: TodayActivity[];
  /** Compact map of day-keys to true for the activity heatmap. */
  history: Record<string, true>;
};

export type RecordResult = {
  state: StreakState;
  isFirstActivityToday: boolean;
  hitMilestone: boolean;
  freezeConsumed: boolean;
};

const MAX_FREEZES = 3;

const MILESTONE_DAYS = new Set([
  1, 7, 21, 30, 40, 50, 60, 70, 80, 90, 100, 150, 200, 365,
]);

export function emptyState(): StreakState {
  return {
    currentStreak: 0,
    longestStreak: 0,
    totalActiveDays: 0,
    freezesAvailable: 0,
    lastActiveDay: null,
    todayActivities: [],
    history: {},
  };
}

export function dayKey(d: Date): string {
  // toISOString() always returns UTC; slice off the date portion.
  return d.toISOString().slice(0, 10);
}

export function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return dayKey(d);
}

export function daysBetween(a: string, b: string): number {
  const da = Date.parse(a + "T00:00:00Z");
  const db = Date.parse(b + "T00:00:00Z");
  return Math.round((db - da) / 86_400_000);
}

function isMilestone(streak: number): boolean {
  if (MILESTONE_DAYS.has(streak)) return true;
  // Past 60 days every multiple of 10 counts — keeps the celebration
  // cadence reasonable for power users without hard-coding every value.
  if (streak > 60 && streak % 10 === 0) return true;
  return false;
}

/**
 * Apply an activity event to a streak state. Returns a new state plus
 * derived flags (isFirstActivityToday for showing the streak pill
 * animation, hitMilestone for celebration UI, freezeConsumed for the
 * "we saved your streak" toast).
 *
 * `now` is injected so tests can pin a deterministic clock; routes
 * pass `new Date()`.
 */
export function recordActivity(
  prev: StreakState,
  event: { source: ActivitySource; label: string },
  now: Date,
): RecordResult {
  const today = dayKey(now);
  const activity: TodayActivity = {
    source: event.source,
    label: event.label,
    timestamp: now.getTime(),
  };

  // Same-UTC-day repeat — append to the day's activity list but don't
  // touch streak counters. This is the "user did 3 lessons in a row"
  // case; only the first one moves the counter.
  if (prev.history[today]) {
    const isStillToday = prev.lastActiveDay === today;
    return {
      state: {
        ...prev,
        lastActiveDay: today,
        todayActivities: isStillToday
          ? [...prev.todayActivities, activity]
          : [activity],
      },
      isFirstActivityToday: false,
      hitMilestone: false,
      freezeConsumed: false,
    };
  }

  // First activity of a new UTC day — recompute the streak.
  let currentStreak: number;
  let freezesAvailable = prev.freezesAvailable;
  let freezeConsumed = false;
  const history = { ...prev.history };

  if (!prev.lastActiveDay) {
    // First-ever activity.
    currentStreak = 1;
  } else {
    const gap = daysBetween(prev.lastActiveDay, today);
    if (gap === 1) {
      currentStreak = prev.currentStreak + 1;
    } else if (gap === 2 && freezesAvailable > 0) {
      // Skipped exactly one day; consume a freeze to keep the streak
      // alive and backfill yesterday in the heatmap so the user sees
      // continuity rather than a hole.
      const yesterday = addDays(today, -1);
      history[yesterday] = true;
      freezesAvailable -= 1;
      currentStreak = prev.currentStreak + 1;
      freezeConsumed = true;
    } else {
      // Two-or-more-day gap (with no freeze) or a backwards date —
      // streak resets.
      currentStreak = 1;
    }
  }

  history[today] = true;
  const totalActiveDays = prev.totalActiveDays + 1;
  const longestStreak = Math.max(prev.longestStreak, currentStreak);

  // Every 7-day milestone awards a freeze (capped). Lives inside the
  // first-of-day branch so streak repeats don't farm freezes.
  if (currentStreak > 0 && currentStreak % 7 === 0) {
    freezesAvailable = Math.min(MAX_FREEZES, freezesAvailable + 1);
  }

  const state: StreakState = {
    currentStreak,
    longestStreak,
    totalActiveDays,
    freezesAvailable,
    lastActiveDay: today,
    todayActivities: [activity],
    history,
  };

  return {
    state,
    isFirstActivityToday: true,
    hitMilestone: isMilestone(currentStreak),
    freezeConsumed,
  };
}
