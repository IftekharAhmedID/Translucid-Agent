export type InvestigationArguments = {
  resumePath?: string;
  submissionPath?: string;
  classification: "SYNTHETIC" | "PUBLIC_PROFESSIONAL";
  providerMode: "fixture" | "live";
  runtime: "LOCAL" | "E2B";
  outputDirectory: string;
  watch: boolean;
  keepDebug: boolean;
};

function value(args: string[], index: number, name: string): string {
  const result = args[index + 1];
  if (!result || result.startsWith("--")) throw new Error(`${name} requires a value.`);
  return result;
}

export function parseInvestigationArguments(args: string[]): InvestigationArguments {
  let resumePath: string | undefined;
  let submissionPath: string | undefined;
  let classification: InvestigationArguments["classification"] | undefined;
  let providerMode: InvestigationArguments["providerMode"] = "fixture";
  let runtime: InvestigationArguments["runtime"] = "LOCAL";
  let outputDirectory = "./runs";
  let watch = false;
  let keepDebug = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--watch") watch = true;
    else if (argument === "--keep-debug") keepDebug = true;
    else if (argument === "--resume") { resumePath = value(args, index, argument); index += 1; }
    else if (argument === "--submission") { submissionPath = value(args, index, argument); index += 1; }
    else if (argument === "--output") { outputDirectory = value(args, index, argument); index += 1; }
    else if (argument === "--classification") {
      const raw = value(args, index, argument);
      if (!new Set(["synthetic", "public-professional"]).has(raw)) throw new Error("Classification must be synthetic or public-professional.");
      classification = raw === "synthetic" ? "SYNTHETIC" : "PUBLIC_PROFESSIONAL";
      index += 1;
    } else if (argument === "--provider-mode") {
      const raw = value(args, index, argument);
      if (raw !== "fixture" && raw !== "live") throw new Error("Provider mode must be fixture or live.");
      providerMode = raw;
      index += 1;
    } else if (argument === "--runtime") {
      const raw = value(args, index, argument);
      if (raw !== "local" && raw !== "e2b") throw new Error("Runtime must be local or e2b.");
      runtime = raw === "local" ? "LOCAL" : "E2B";
      index += 1;
    } else throw new Error(`Unknown argument ${argument}.`);
  }
  if (!resumePath && !submissionPath) throw new Error("At least one input is required through --resume or --submission.");
  if (!classification) throw new Error("--classification is required.");
  if (classification === "PUBLIC_PROFESSIONAL" && providerMode !== "live") throw new Error("Public-professional classification requires live provider mode.");
  return {
    ...(resumePath ? { resumePath } : {}),
    ...(submissionPath ? { submissionPath } : {}),
    classification,
    providerMode,
    runtime,
    outputDirectory,
    watch,
    keepDebug,
  };
}
