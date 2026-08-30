import { describe, expect, it } from "vitest";

import {
  DEEP_SEEK_NATIVE_SESSION_CWD_MAX_LENGTH,
  DEEP_SEEK_NATIVE_SESSION_ID_MAX_LENGTH,
  DEEP_SEEK_NATIVE_SESSION_TITLE_MAX_LENGTH,
  deepSeekNativeSessionCandidatesParamsSchema,
  deepSeekNativeSessionCandidatesResultSchema,
  deepSeekNativeSessionLinkParamsSchema,
  deepSeekNativeSessionLinkResultSchema,
} from "../src/index.js";

const candidate = {
  nativeSessionId: "session-existing-1",
  title: "Existing native session",
  updatedAt: 1_725_000_000_000,
  cwd: "C:\\workspace\\codex-host",
  running: false,
  blank: false,
} as const;

describe("DeepSeek Native Session contracts", () => {
  it("accepts the fixed candidate and link shapes", () => {
    expect(deepSeekNativeSessionCandidatesParamsSchema.parse({ cwd: candidate.cwd })).toEqual({
      cwd: candidate.cwd,
    });
    expect(deepSeekNativeSessionCandidatesResultSchema.parse({ candidates: [candidate] })).toEqual({
      candidates: [candidate],
    });
    expect(
      deepSeekNativeSessionLinkParamsSchema.parse({
        cwd: candidate.cwd,
        nativeSessionId: candidate.nativeSessionId,
      }),
    ).toEqual({ cwd: candidate.cwd, nativeSessionId: candidate.nativeSessionId });
    expect(deepSeekNativeSessionLinkResultSchema.parse({ threadId: "thread-linked-1" })).toEqual({
      threadId: "thread-linked-1",
    });
  });

  it("accepts missing native display title only as null", () => {
    expect(
      deepSeekNativeSessionCandidatesResultSchema.parse({
        candidates: [{ ...candidate, title: null, blank: true }],
      }),
    ).toEqual({ candidates: [{ ...candidate, title: null, blank: true }] });
  });

  it.each([
    ["blank cwd", deepSeekNativeSessionCandidatesParamsSchema, { cwd: " \t " }],
    [
      "long cwd",
      deepSeekNativeSessionCandidatesParamsSchema,
      { cwd: "x".repeat(DEEP_SEEK_NATIVE_SESSION_CWD_MAX_LENGTH + 1) },
    ],
    [
      "blank Session id",
      deepSeekNativeSessionLinkParamsSchema,
      { cwd: candidate.cwd, nativeSessionId: "\n" },
    ],
    [
      "long Session id",
      deepSeekNativeSessionLinkParamsSchema,
      {
        cwd: candidate.cwd,
        nativeSessionId: "x".repeat(DEEP_SEEK_NATIVE_SESSION_ID_MAX_LENGTH + 1),
      },
    ],
    [
      "long title",
      deepSeekNativeSessionCandidatesResultSchema,
      {
        candidates: [
          { ...candidate, title: "x".repeat(DEEP_SEEK_NATIVE_SESSION_TITLE_MAX_LENGTH + 1) },
        ],
      },
    ],
    [
      "non-finite update time",
      deepSeekNativeSessionCandidatesResultSchema,
      { candidates: [{ ...candidate, updatedAt: Number.POSITIVE_INFINITY }] },
    ],
    [
      "invented preview",
      deepSeekNativeSessionCandidatesResultSchema,
      { candidates: [{ ...candidate, preview: "not in the DSH protocol" }] },
    ],
    [
      "injected link metadata",
      deepSeekNativeSessionLinkParamsSchema,
      { cwd: candidate.cwd, nativeSessionId: candidate.nativeSessionId, title: candidate.title },
    ],
    [
      "generic Harness selector",
      deepSeekNativeSessionCandidatesParamsSchema,
      { cwd: candidate.cwd, harnessId: "deepseek-harness" },
    ],
    [
      "extended result",
      deepSeekNativeSessionLinkResultSchema,
      { threadId: "thread-linked-1", nativeSessionId: candidate.nativeSessionId },
    ],
  ])("rejects %s", (_name, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });
});
