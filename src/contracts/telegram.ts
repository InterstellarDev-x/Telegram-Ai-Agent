import { z } from "zod";

export const telegramPhotoSizeSchema = z.object({
  file_id: z.string().min(1),
  file_unique_id: z.string().min(1).optional(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  file_size: z.number().int().nonnegative().optional(),
});

export type TelegramPhotoSize = z.infer<typeof telegramPhotoSizeSchema>;

export const telegramDocumentSchema = z.object({
  file_id: z.string().min(1),
  file_unique_id: z.string().min(1).optional(),
  file_name: z.string().optional(),
  mime_type: z.string().optional(),
  file_size: z.number().int().nonnegative().optional(),
});

export type TelegramDocument = z.infer<typeof telegramDocumentSchema>;

export const telegramChatSchema = z.object({
  id: z.number(),
  type: z.string().min(1),
  title: z.string().optional(),
  username: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
});

export type TelegramChat = z.infer<typeof telegramChatSchema>;

export const telegramMessageSchema = z.object({
  message_id: z.number().int().nonnegative(),
  date: z.number().int().nonnegative(),
  chat: telegramChatSchema,
  text: z.string().optional(),
  caption: z.string().optional(),
  photo: z.array(telegramPhotoSizeSchema).optional(),
  document: telegramDocumentSchema.optional(),
});

export type TelegramMessage = z.infer<typeof telegramMessageSchema>;

export const telegramUpdateSchema = z.object({
  update_id: z.number().int().nonnegative(),
  message: telegramMessageSchema.optional(),
  edited_message: telegramMessageSchema.optional(),
});

export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;

export const telegramApiEnvelopeSchema = z.object({
  ok: z.boolean(),
  description: z.string().optional(),
});

export const telegramFileSchema = z.object({
  file_id: z.string().min(1),
  file_unique_id: z.string().min(1).optional(),
  file_path: z.string().min(1).optional(),
  file_size: z.number().int().nonnegative().optional(),
});

export type TelegramFile = z.infer<typeof telegramFileSchema>;

export const telegramGetFileResponseSchema = telegramApiEnvelopeSchema.extend({
  result: telegramFileSchema.optional(),
});

export type TelegramGetFileResponse = z.infer<typeof telegramGetFileResponseSchema>;
