import { describe, expect, it } from "vitest";
import {
  emptyState,
  recordActivity,
  dayKey,
  addDays,
  daysBetween,
} from "../../src/lib/streak.js";

/**
 * Pure-function tests for the streak math.
 *
 * No DB, no fastify, no clock mocking — we pass `now` explicitly so
 * every branch (first-ever, same-day repeat, consecutive day, 1-day
 * gap with/without freeze, 3+ day gap, milestones, freeze farming
 * via 7-day cadence) can be asserted deterministically.
 */

const noon = (yyyyMmDd: string) => new Date(`${yyyyMmDd}T12:00:00Z`);

describe("day helpers", () => {
  it("dayKey returns UTC YYYY-MM-DD regardless of local timezone", () => {
    expect(dayKey(new Date("2026-05-19T23:30:00Z"))).toBe("2026-05-19");
    // A timestamp that's tomorrow in IST is still today in UTC.
    expect(dayKey(new Date("2026-05-19T21:00:00Z"))).toBe("2026-05-19");
  });
  it("addDays handles month rollover", () => {
    expect(addDays("2026-05-31", 1)).toBe("2026-06-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("daysBetween counts whole UTC days", () => {
    expect(daysBetween("2026-05-19", "2026-05-20")).toBe(1);
    expect(daysBetween("2026-05-19", "2026-05-19")).toBe(0);
    expect(daysBetween("2026-05-19", "2026-05-26")).toBe(7);
  });
});

describe("recordActivity — first activity", () => {
  it("creates streak=1 from empty state", () => {
    const r = recordActivity(
      emptyState(),
      { source: "lesson", label: "Intro" },
      noon("2026-05-19"),
    );
    expect(r.state.currentStreak).toBe(1);
    expect(r.state.longestStreak).toBe(1);
    expect(r.state.totalActiveDays).toBe(1);
    expect(r.state.lastActiveDay).toBe("2026-05-19");
    expect(r.state.history).toEqual({ "2026-05-19": true });
    expect(r.state.todayActivities).toHaveLength(1);
    expect(r.isFirstActivityToday).toBe(true);
    expect(r.hitMilestone).toBe(true); // 1 is a milestone
    expect(r.freezeConsumed).toBe(false);
  });
});

describe("recordActivity — same day", () => {
  it("appends to todayActivities without bumping streak", () => {
    const first = recordActivity(
      emptyState(),
      { source: "lesson", label: "L1" },
      noon("2026-05-19"),
    ).state;
    const second = recordActivity(
      first,
      { source: "quiz", label: "Q1" },
      new Date("2026-05-19T15:30:00Z"),
    );
    expect(second.state.currentStreak).toBe(1);
    expect(second.state.totalActiveDays).toBe(1);
    expect(second.state.todayActivities).toHaveLength(2);
    expect(second.isFirstActivityToday).toBe(false);
    expect(second.hitMilestone).toBe(false);
  });
});

describe("recordActivity — consecutive days", () => {
  it("increments streak on day +1", () => {
    let state = recordActivity(
      emptyState(),
      { source: "lesson", label: "L1" },
      noon("2026-05-19"),
    ).state;
    state = recordActivity(
      state,
      { source: "lesson", label: "L2" },
      noon("2026-05-20"),
    ).state;
    expect(state.currentStreak).toBe(2);
    expect(state.longestStreak).toBe(2);
    expect(state.totalActiveDays).toBe(2);
    expect(state.todayActivities).toHaveLength(1); // reset for new day
  });

  it("awards a freeze on the 7th consecutive day", () => {
    let state = emptyState();
    for (let i = 0; i < 7; i++) {
      state = recordActivity(
        state,
        { source: "lesson", label: `L${i}` },
        noon(addDays("2026-05-19", i)),
      ).state;
    }
    expect(state.currentStreak).toBe(7);
    expect(state.freezesAvailable).toBe(1);
  });

  it("caps freezes at MAX_FREEZES (3)", () => {
    // Need 28 consecutive days to attempt to bank 4 freezes (7,14,21,28).
    let state = emptyState();
    for (let i = 0; i < 28; i++) {
      state = recordActivity(
        state,
        { source: "lesson", label: `L${i}` },
        noon(addDays("2026-05-19", i)),
      ).state;
    }
    expect(state.currentStreak).toBe(28);
    expect(state.freezesAvailable).toBe(3);
  });
});

describe("recordActivity — one-day forgiveness (gap === 2)", () => {
  it("missing exactly one day is FREE — no freeze cost, streak continues", () => {
    // Build only 1 day so no freezes are available.
    let state = recordActivity(
      emptyState(),
      { source: "lesson", label: "L1" },
      noon("2026-05-19"),
    ).state;
    expect(state.freezesAvailable).toBe(0);
    // Skip exactly one day (active Mon, missed Tue, active Wed).
    const after = recordActivity(
      state,
      { source: "lesson", label: "resume" },
      noon("2026-05-21"),
    );
    expect(after.freezeConsumed).toBe(false);
    expect(after.state.freezesAvailable).toBe(0); // no freeze touched
    expect(after.state.currentStreak).toBe(2);
    // The skipped day gets backfilled in the heatmap.
    expect(after.state.history["2026-05-20"]).toBe(true);
  });

  it("one-day forgiveness still applies even if freezes are available", () => {
    // Build to 7 days so a freeze IS banked, then skip one.
    let state = emptyState();
    for (let i = 0; i < 7; i++) {
      state = recordActivity(
        state,
        { source: "lesson", label: `L${i}` },
        noon(addDays("2026-05-19", i)),
      ).state;
    }
    expect(state.freezesAvailable).toBe(1);
    const after = recordActivity(
      state,
      { source: "lesson", label: "resume" },
      noon("2026-05-27"),
    );
    expect(after.freezeConsumed).toBe(false); // free pass, no freeze burned
    expect(after.state.freezesAvailable).toBe(1); // freeze preserved
    expect(after.state.currentStreak).toBe(8);
  });
});

describe("recordActivity — two-day gap (gap === 3) consumes freeze", () => {
  it("consumes a freeze when missing 2 days and backfills both", () => {
    // Build to 7 days so a freeze is available.
    let state = emptyState();
    for (let i = 0; i < 7; i++) {
      state = recordActivity(
        state,
        { source: "lesson", label: `L${i}` },
        noon(addDays("2026-05-19", i)),
      ).state;
    }
    expect(state.freezesAvailable).toBe(1);
    // Skip TWO days. last active = 2026-05-25, next event on 2026-05-28.
    const after = recordActivity(
      state,
      { source: "lesson", label: "resume" },
      noon("2026-05-28"),
    );
    expect(after.freezeConsumed).toBe(true);
    expect(after.state.freezesAvailable).toBe(0);
    expect(after.state.currentStreak).toBe(8);
    // Both missed days backfilled in the heatmap.
    expect(after.state.history["2026-05-26"]).toBe(true);
    expect(after.state.history["2026-05-27"]).toBe(true);
  });
});

describe("recordActivity — streak resets on big gaps", () => {
  it("resets streak after a 2-day-missed gap with no freezes (gap === 3, no freeze)", () => {
    // Active 1 day, then skip 2 days. No freezes available.
    let state = recordActivity(
      emptyState(),
      { source: "lesson", label: "L1" },
      noon("2026-05-19"),
    ).state;
    expect(state.freezesAvailable).toBe(0);
    const after = recordActivity(
      state,
      { source: "lesson", label: "L2" },
      noon("2026-05-22"),
    );
    expect(after.state.currentStreak).toBe(1);
    expect(after.freezeConsumed).toBe(false);
  });

  it("resets streak on a 3+ day gap even with freezes available", () => {
    // Build to 7 days for a freeze, then skip 3 days (gap === 4).
    let state = emptyState();
    for (let i = 0; i < 7; i++) {
      state = recordActivity(
        state,
        { source: "lesson", label: `L${i}` },
        noon(addDays("2026-05-19", i)),
      ).state;
    }
    const after = recordActivity(
      state,
      { source: "lesson", label: "much later" },
      noon("2026-05-29"),
    );
    expect(after.freezeConsumed).toBe(false);
    expect(after.state.currentStreak).toBe(1);
    expect(after.state.freezesAvailable).toBe(1); // freeze not consumed
  });
});

describe("recordActivity — longest streak", () => {
  it("preserves longestStreak across resets", () => {
    let state = emptyState();
    // 10 days
    for (let i = 0; i < 10; i++) {
      state = recordActivity(
        state,
        { source: "lesson", label: `L${i}` },
        noon(addDays("2026-05-19", i)),
      ).state;
    }
    expect(state.longestStreak).toBe(10);
    // Skip 5 days, streak resets.
    const after = recordActivity(
      state,
      { source: "lesson", label: "comeback" },
      noon(addDays("2026-05-19", 15)),
    ).state;
    expect(after.currentStreak).toBe(1);
    expect(after.longestStreak).toBe(10); // preserved
  });
});

describe("recordActivity — milestone flag", () => {
  it("fires on 7-day mark", () => {
    let state = emptyState();
    let lastResult;
    for (let i = 0; i < 7; i++) {
      lastResult = recordActivity(
        state,
        { source: "lesson", label: `L${i}` },
        noon(addDays("2026-05-19", i)),
      );
      state = lastResult.state;
    }
    expect(lastResult!.hitMilestone).toBe(true);
    expect(state.currentStreak).toBe(7);
  });
  it("does not fire on day 2", () => {
    let state = recordActivity(
      emptyState(),
      { source: "lesson", label: "L1" },
      noon("2026-05-19"),
    ).state;
    const r = recordActivity(
      state,
      { source: "lesson", label: "L2" },
      noon("2026-05-20"),
    );
    expect(r.hitMilestone).toBe(false);
  });
});
