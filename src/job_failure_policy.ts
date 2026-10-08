import { z } from "zod";

export const buildJobSchema = z.object({
  kind: z.literal("build_event"),
  buildId: z.string().min(1),
  releaseId: z.string().min(1),
  tool: z.string().min(1),
  command: z.string().min(1),
  attempt: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  failure: z.object({
    summary: z.string().min(1),
    occurredAt: z.string().datetime()
  })
}).refine((job) => job.attempt <= job.maxAttempts, {
  message: "attempt cannot exceed maxAttempts",
  path: ["attempt"]
});

export type BuildJob = z.infer<typeof buildJobSchema>;

export type FailureDecision =
  | { action: "retry"; next: BuildJob }
  | { action: "dead_letter"; diagnostic: DeveloperDiagnostic };

export type DeveloperDiagnostic = {
  kind: "developer_diagnostic";
  buildId: string;
  releaseId: string;
  tool: string;
  failedCommand: string;
  attempts: number;
  summary: string;
  nextStep: string;
};

export function decideFailure(job: BuildJob): FailureDecision {
  if (job.attempt < job.maxAttempts) {
    return {
      action: "retry",
      next: { ...job, attempt: job.attempt + 1 }
    };
  }

  return {
    action: "dead_letter",
    diagnostic: {
      kind: "developer_diagnostic",
      buildId: job.buildId,
      releaseId: job.releaseId,
      tool: job.tool,
      failedCommand: job.command,
      attempts: job.attempt,
      summary: job.failure.summary,
      nextStep: `Inspect build ${job.buildId}, correct the tool input, then replay the release operation.`
    }
  };
}
