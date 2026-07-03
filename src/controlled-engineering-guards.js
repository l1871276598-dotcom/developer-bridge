import {
  guardControlledEngineeringTool,
  validateControlledWorkflow as validatePolicyWorkflow,
} from "./controlled-engineering-guards-policy.js";

export { guardControlledEngineeringTool };

export function validateControlledWorkflow(pathValue, content) {
  try {
    return validatePolicyWorkflow(pathValue, content);
  } catch (error) {
    if (error?.message === "Checkout inputs are not allowlisted.") {
      throw new Error("Checkout inputs are not allowlisted; persist-credentials: false is required.");
    }
    throw error;
  }
}
