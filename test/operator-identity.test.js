import assert from "node:assert/strict";
import test from "node:test";

import {
  createOperatorAuditLogger,
  operatorIdentityFromEnvironment,
} from "../src/audit-actor.js";

test("loads one immutable trusted local operator identity from the environment", () => {
  const identity = operatorIdentityFromEnvironment({
    DEVELOPER_BRIDGE_OPERATOR_ID: "li-linsen.local",
  });

  assert.deepEqual(identity, {
    id: "li-linsen.local",
    type: "local-human",
  });
  assert.equal(Object.isFrozen(identity), true);
});

test("fails closed for missing or invalid operator identities without echoing them", () => {
  for (const value of [
    undefined,
    "",
    " operator",
    "operator ",
    "operator name",
    "operator/name",
    "operator\nforged=true",
    "https://operator.invalid",
    "x".repeat(65),
  ]) {
    assert.throws(
      () => operatorIdentityFromEnvironment({
        ...(value === undefined ? {} : { DEVELOPER_BRIDGE_OPERATOR_ID: value }),
      }),
      (error) => {
        assert.match(error.message, /DEVELOPER_BRIDGE_OPERATOR_ID/);
        if (value) assert.doesNotMatch(error.message, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        return true;
      },
    );
  }
});

test("adds the immutable operator identity to one-line audit logs", () => {
  const lines = [];
  const identity = operatorIdentityFromEnvironment({
    DEVELOPER_BRIDGE_OPERATOR_ID: "local.operator-1",
  });
  const logger = createOperatorAuditLogger((line) => lines.push(line), identity);

  logger("2026-07-03T00:00:00.000Z tool=git_status result=success duration_ms=1");

  assert.deepEqual(lines, [
    "2026-07-03T00:00:00.000Z tool=git_status operator_id=local.operator-1 operator_type=local-human result=success duration_ms=1",
  ]);
});
