import assert from "node:assert/strict";
import test from "node:test";
import { buildJobSchema, decideFailure } from "../src/job_failure_policy.js";

const finalFailure = buildJobSchema.parse({
  kind: "build_event",
  buildId: "build-1842",
  releaseId: "release-2026-09-06",
  tool: "typescript-compiler",
  command: "npm run typecheck",
  attempt: 3,
  maxAttempts: 3,
  failure: {
    summary: "Generated client types disagree with the release schema",
    occurredAt: "2026-09-06T08:30:00.000Z"
  }
});

test("a build at its attempt limit becomes an actionable developer diagnostic", () => {
  const decision = decideFailure(finalFailure);

  assert.equal(decision.action, "dead_letter");
  if (decision.action === "dead_letter") {
    assert.deepEqual(decision.diagnostic, {
      kind: "developer_diagnostic",
      buildId: "build-1842",
      releaseId: "release-2026-09-06",
      tool: "typescript-compiler",
      failedCommand: "npm run typecheck",
      attempts: 3,
      summary: "Generated client types disagree with the release schema",
      nextStep: "Inspect build build-1842, correct the tool input, then replay the release operation."
    });
  }
});

test("a build below its attempt limit is scheduled with the next attempt", () => {
  const decision = decideFailure({ ...finalFailure, attempt: 2 });

  assert.equal(decision.action, "retry");
  if (decision.action === "retry") assert.equal(decision.next.attempt, 3);
});
