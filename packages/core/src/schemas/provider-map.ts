import { z } from "zod";

export const ProviderTargetSchema = z.object({
  siteId: z.string().min(1, "siteId is required"),
  provider: z.string().min(1, "provider is required"),
  strategy: z.string().optional()
}).passthrough();

export const ProviderMapSchema = z.object({
  targets: z.array(ProviderTargetSchema)
}).passthrough();

export type ZodProviderTarget = z.infer<typeof ProviderTargetSchema>;
export type ZodProviderMap = z.infer<typeof ProviderMapSchema>;
