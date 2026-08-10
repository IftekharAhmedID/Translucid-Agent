import { z } from "zod";

export const investigationStatusSchema = z.enum([
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
]);

export const runtimeKindSchema = z.enum(["LOCAL", "E2B"]);
export const dataClassificationSchema = z.enum(["SYNTHETIC", "PUBLIC_PROFESSIONAL"]);

export const entityTypeSchema = z.enum([
  "PERSON",
  "ORGANIZATION",
  "ACCOUNT",
  "WEBSITE",
  "PUBLICATION",
  "PATENT",
  "PACKAGE",
]);

export const researchQuestionStatusSchema = z.enum([
  "OPEN",
  "IN_PROGRESS",
  "RESOLVED",
  "EXHAUSTED",
  "SKIPPED",
]);

export const claimVerdictSchema = z.enum([
  "CORROBORATED",
  "PARTIALLY_CORROBORATED",
  "CONTRADICTED",
  "UNRESOLVED",
]);

export const evidenceStrengthSchema = z.enum(["STRONG", "MODERATE", "WEAK"]);

export const investigationSummarySchema = z
  .object({
    professionalIdentity: z
      .object({
        status: z.enum(["RESOLVED", "PARTIAL", "AMBIGUOUS"]),
        summary: z.string().min(1).max(4_000),
        evidenceIds: z.array(z.string().min(1)).max(100),
      })
      .strict(),
    professionalTimelineSummary: z.string().min(1).max(8_000),
    strongestEvidenceIds: z.array(z.string().min(1)).max(100),
    materialInconsistencies: z
      .array(
        z
          .object({
            claimId: z.string().min(1),
            summary: z.string().min(1).max(4_000),
            evidenceIds: z.array(z.string().min(1)).min(1).max(100),
          })
          .strict(),
      )
      .max(100),
    unresolvedMaterialClaimIds: z.array(z.string().min(1)).max(500),
    investigationLimitations: z.array(z.string().min(1).max(2_000)).max(100),
  })
  .strict();

export const findingOutputSchema = z
  .object({
    claimId: z.string().min(1),
    verdict: claimVerdictSchema,
    strength: evidenceStrengthSchema,
    explanation: z.string().min(1).max(8_000),
    supportingEvidenceIds: z.array(z.string().min(1)).max(100),
    contradictingEvidenceIds: z.array(z.string().min(1)).max(100),
    limitations: z.array(z.string().min(1).max(2_000)).max(100),
  })
  .strict();

export const adjudicationOutputSchema = z
  .object({
    summary: investigationSummarySchema,
    findings: z.array(findingOutputSchema).max(500),
  })
  .strict();

export type InvestigationStatus = z.infer<typeof investigationStatusSchema>;
export type RuntimeKind = z.infer<typeof runtimeKindSchema>;
export type DataClassification = z.infer<typeof dataClassificationSchema>;
export type EntityType = z.infer<typeof entityTypeSchema>;
export type ResearchQuestionStatus = z.infer<typeof researchQuestionStatusSchema>;
export type ClaimVerdict = z.infer<typeof claimVerdictSchema>;
export type InvestigationSummary = z.infer<typeof investigationSummarySchema>;
export type FindingOutput = z.infer<typeof findingOutputSchema>;
export type AdjudicationOutput = z.infer<typeof adjudicationOutputSchema>;
export type ResearchWaveKind = "INITIAL" | "TARGETED";
export type EscalationReason =
  | "MATERIAL_CONTRADICTION"
  | "IDENTITY_AMBIGUITY"
  | "CHRONOLOGY_CONFLICT"
  | "NEW_EVIDENCE_FAMILY"
  | "MATERIAL_UNCERTAINTY";

export type ApiError = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};
