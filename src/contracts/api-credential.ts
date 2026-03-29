import { z } from "zod";

export const apiCredentialProviderSchema = z.enum(["openai", "gemini"]);

export const createApiCredentialRequestSchema = z.object({
  provider: apiCredentialProviderSchema,
  apiKey: z.string().min(1),
  label: z.string().trim().min(1).max(120).optional(),
  model: z.string().trim().min(1).max(120).optional(),
  isActive: z.boolean().optional().default(true),
});

export type CreateApiCredentialRequest = z.infer<
  typeof createApiCredentialRequestSchema
>;
