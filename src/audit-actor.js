const OPERATOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const OPERATOR_TYPE = "local-human";

function validateOperatorId(value) {
  if (typeof value !== "string" || !OPERATOR_ID_PATTERN.test(value)) {
    throw new Error("DEVELOPER_BRIDGE_OPERATOR_ID is required and must use 1-64 ASCII letters, digits, dots, underscores, or hyphens.");
  }
  return value;
}

export function operatorIdentityFromEnvironment(env) {
  const id = validateOperatorId(env?.DEVELOPER_BRIDGE_OPERATOR_ID);
  return Object.freeze({ id, type: OPERATOR_TYPE });
}

export function createOperatorAuditLogger(logger, identity) {
  if (typeof logger !== "function") throw new Error("Audit logger must be a function.");
  if (!identity || identity.type !== OPERATOR_TYPE) throw new Error("Operator identity is invalid.");
  const id = validateOperatorId(identity.id);
  const fields = `operator_id=${id} operator_type=${OPERATOR_TYPE}`;

  return (line) => {
    const text = String(line);
    const resultIndex = text.lastIndexOf(" result=");
    logger(resultIndex < 0
      ? `${text} ${fields}`
      : `${text.slice(0, resultIndex)} ${fields}${text.slice(resultIndex)}`);
  };
}
