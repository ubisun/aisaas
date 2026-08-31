import { describe, expect, it } from "vitest";

import { ROSTER, onDuty, standbyResponse, type Department } from "@/lib/teams/roster";

/**
 * Who is working.
 *
 * The roster is the in-repo answer to a question that previously could only be
 * answered from the Upstash console. What is tested here is not which
 * departments happen to be on duty today -- that changes, and a test asserting
 * it would have to be edited every time it did -- but that the mechanism means
 * what the job endpoints assume it means.
 */

const DEPARTMENTS: Department[] = ["market-report", "trading", "strategy"];

describe("the roster", () => {
  it("has an entry for every department", () => {
    for (const department of DEPARTMENTS) {
      expect(ROSTER[department]).toBeDefined();
    }
  });

  it("agrees with itself about who is on duty", () => {
    for (const department of DEPARTMENTS) {
      expect(onDuty(department)).toBe(ROSTER[department].onDuty);
    }
  });

  it("records when and why for every entry", () => {
    // A department stood down without a reason is one nobody can bring back
    // with any confidence.
    for (const department of DEPARTMENTS) {
      expect(ROSTER[department].since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(ROSTER[department].note.length).toBeGreaterThan(0);
    }
  });
});

describe("the standby reply", () => {
  it("answers 200 so the queue stops retrying work nobody wants done", async () => {
    const response = standbyResponse("strategy");
    expect(response.status).toBe(200);
  });

  it("says which department declined, and why", async () => {
    const body = (await standbyResponse("strategy").json()) as Record<string, unknown>;
    expect(body.department).toBe("strategy");
    expect(body.status).toBe("standby");
    expect(body.enqueued).toBe(false);
    expect(body.note).toBe(ROSTER.strategy.note);
  });

  it("never claims to have queued anything", async () => {
    for (const department of DEPARTMENTS) {
      const body = (await standbyResponse(department).json()) as Record<string, unknown>;
      expect(body.enqueued).toBe(false);
    }
  });
});
