import { z } from "zod";

import { hostThreadIdSchema } from "./ids.js";

export const DEEP_SEEK_NATIVE_SESSION_ID_MAX_LENGTH = 1_024;
export const DEEP_SEEK_NATIVE_SESSION_CWD_MAX_LENGTH = 16_384;
export const DEEP_SEEK_NATIVE_SESSION_TITLE_MAX_LENGTH = 4_096;
export const DEEP_SEEK_NATIVE_SESSION_CANDIDATES_MAX_LENGTH = 10_000;

const boundedNonBlankString = (maxLength: number) =>
  z
    .string()
    .max(maxLength)
    .refine((value) => value.trim().length > 0, { message: "Value must not be blank" });

const nativeSessionIdSchema = boundedNonBlankString(DEEP_SEEK_NATIVE_SESSION_ID_MAX_LENGTH);
const cwdSchema = boundedNonBlankString(DEEP_SEEK_NATIVE_SESSION_CWD_MAX_LENGTH);

export const deepSeekNativeSessionCandidateSchema = z.strictObject({
  nativeSessionId: nativeSessionIdSchema,
  title: boundedNonBlankString(DEEP_SEEK_NATIVE_SESSION_TITLE_MAX_LENGTH).nullable(),
  updatedAt: z.number().finite(),
  cwd: cwdSchema,
  running: z.boolean(),
  blank: z.boolean(),
});

export type DeepSeekNativeSessionCandidate = z.infer<typeof deepSeekNativeSessionCandidateSchema>;

export const deepSeekNativeSessionCandidatesParamsSchema = z.strictObject({ cwd: cwdSchema });
export type DeepSeekNativeSessionCandidatesParams = z.infer<
  typeof deepSeekNativeSessionCandidatesParamsSchema
>;

export const deepSeekNativeSessionCandidatesResultSchema = z.strictObject({
  candidates: z
    .array(deepSeekNativeSessionCandidateSchema)
    .max(DEEP_SEEK_NATIVE_SESSION_CANDIDATES_MAX_LENGTH),
});
export type DeepSeekNativeSessionCandidatesResult = z.infer<
  typeof deepSeekNativeSessionCandidatesResultSchema
>;

export const deepSeekNativeSessionLinkParamsSchema = z.strictObject({
  cwd: cwdSchema,
  nativeSessionId: nativeSessionIdSchema,
});
export type DeepSeekNativeSessionLinkParams = z.infer<typeof deepSeekNativeSessionLinkParamsSchema>;

export const deepSeekNativeSessionLinkResultSchema = z.strictObject({
  threadId: hostThreadIdSchema,
});
export type DeepSeekNativeSessionLinkResult = z.infer<typeof deepSeekNativeSessionLinkResultSchema>;
