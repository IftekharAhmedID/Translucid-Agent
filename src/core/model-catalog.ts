export const PAID_GO_MODEL_IDS = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "mimo-v2.5-pro",
] as const;

export const PAID_GO_MODEL_SET = new Set<string>(PAID_GO_MODEL_IDS);
