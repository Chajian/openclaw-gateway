import { z } from "zod";

export const SiteConfigSchema = z.object({
  id: z.string().min(1, "site id is required"),
  type: z.string().min(1, "site type is required"),
  enabled: z.boolean(),
  baseUrl: z.string().optional(),
  url: z.string().optional(),
  auth: z.record(z.unknown()).optional(),
  settings: z.record(z.unknown()).optional(),
  discovery: z.record(z.unknown()).optional()
}).passthrough();

export const SitesConfigSchema = z.object({
  sites: z.array(SiteConfigSchema)
}).passthrough();

export type ZodSiteConfig = z.infer<typeof SiteConfigSchema>;
export type ZodSitesConfig = z.infer<typeof SitesConfigSchema>;
