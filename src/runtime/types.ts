export const openCodeRuntimeEnvironment = {
  HOME: "/tmp/translucid-opencode",
  XDG_CONFIG_HOME: "/tmp/translucid-opencode/.config",
} as const;

export type RuntimeStartInput = {
  investigationId: string;
  runId: string;
  caseDirectory: string;
  gatewayUrl: string;
  caseToken: string;
  openCodePassword: string;
  expectedManifestHash?: string;
  timeoutMs: number;
  mode?: "headless";
  deadlineAt?: string;
  allowStaleCaseManifest?: boolean;
};

export type RunHandle = {
  kind: "LOCAL" | "E2B";
  id: string;
  openCodeUrl: string;
  accessHeaders?: Record<string, string>;
  manifestHash: string;
};

export type RunStatus = "STARTING" | "RUNNING" | "STOPPED" | "FAILED";

export interface InvestigatorRuntime {
  start(input: RuntimeStartInput): Promise<RunHandle>;
  stop(handle: RunHandle): Promise<void>;
  getStatus(handle: RunHandle): Promise<RunStatus>;
  getOpenCodeUrl(handle: RunHandle): Promise<string>;
}
