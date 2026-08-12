import { isAbsolute, resolve } from "node:path";

export type FinalizeArguments = {
  runDirectory: string;
  keepDebug: boolean;
};

function value(args: string[], index: number, name: string): string {
  const result = args[index + 1];
  if (!result || result.startsWith("--")) throw new Error(`${name} requires a value.`);
  return result;
}

export function parseFinalizeArguments(args: string[]): FinalizeArguments {
  let runDirectory: string | undefined;
  let keepDebug = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--keep-debug") keepDebug = true;
    else if (argument === "--run") {
      runDirectory = value(args, index, argument);
      index += 1;
    } else throw new Error(`Unknown argument ${argument}.`);
  }
  if (!runDirectory) throw new Error("--run requires an absolute run directory.");
  if (!isAbsolute(runDirectory)) throw new Error("--run must be an absolute run directory.");
  return { runDirectory: resolve(runDirectory), keepDebug };
}
