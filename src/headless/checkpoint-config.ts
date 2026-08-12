import { runProcess } from "../runtime/process.ts";
import {
  FINALIZER_IMPLEMENTATION_VERSION,
  hashBundle,
  RESEARCH_CONTRACT_VERSION,
  RESULT_SCHEMA_VERSION,
  type DossierCheckpointConfig,
  type ResearchCheckpointConfig,
} from "./checkpoint.ts";
import { EVIDENCE_DOSSIER_FORMAT_VERSION } from "./dossier.ts";
import { DOSSIER_PROMPT_CONTRACT, ENCODER_PROMPT_CONTRACT, RESEARCH_PROMPT_CONTRACT } from "./prompt-contracts.ts";

const researchAgents = [
  "runtime/headless-opencode/agents/lead-researcher.md",
  "runtime/headless-opencode/agents/professional-researcher.md",
  "runtime/headless-opencode/agents/github-researcher.md",
  "runtime/headless-opencode/agents/web-records-researcher.md",
  "runtime/headless-opencode/agents/social-researcher.md",
];
const researchSkills = [
  "employment-chronology",
  "entity-resolution",
  "public-record-verification",
  "source-evaluation",
  "technical-contribution",
].map((name) => `runtime/headless-opencode/skills/${name}/SKILL.md`);
const compilerSkills = ["entity-resolution", "source-evaluation"].map((name) => `runtime/headless-opencode/skills/${name}/SKILL.md`);

async function gitCommit(root: string): Promise<string> {
  const result = await runProcess("git", ["rev-parse", "HEAD"], { cwd: root, timeoutMs: 10_000 });
  return result.stdout.trim();
}

export async function currentCheckpointConfigs(input: {
  repositoryRoot: string;
  runtime: "LOCAL" | "E2B";
  providerMode: "fixture" | "live";
  researchModel: string;
  compilerModel: string;
  runtimeManifestHash: string;
}): Promise<{ research: ResearchCheckpointConfig; dossier: DossierCheckpointConfig }> {
  const producingGitCommit = await gitCommit(input.repositoryRoot);
  const [researchPromptHash, researchSkillBundleHash, compilerPromptHash, compilerSkillBundleHash] = await Promise.all([
    hashBundle(input.repositoryRoot, researchAgents, { RESEARCH_PROMPT_CONTRACT }),
    hashBundle(input.repositoryRoot, researchSkills),
    hashBundle(input.repositoryRoot, ["runtime/headless-opencode/agents/evidence-compiler.md"], { DOSSIER_PROMPT_CONTRACT, ENCODER_PROMPT_CONTRACT }),
    hashBundle(input.repositoryRoot, compilerSkills),
  ]);
  return {
    research: {
      runtime: input.runtime,
      providerMode: input.providerMode,
      researchModel: input.researchModel,
      runtimeManifestHash: input.runtimeManifestHash,
      researchPromptHash,
      researchSkillBundleHash,
      contractVersion: RESEARCH_CONTRACT_VERSION,
      producingGitCommit,
    },
    dossier: {
      compilerModel: input.compilerModel,
      resultSchemaVersion: RESULT_SCHEMA_VERSION,
      dossierFormatVersion: EVIDENCE_DOSSIER_FORMAT_VERSION,
      compilerPromptHash,
      compilerSkillBundleHash,
      finalizerImplementationVersion: FINALIZER_IMPLEMENTATION_VERSION,
      producingGitCommit,
    },
  };
}
