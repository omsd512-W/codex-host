import nodePath from "node:path";

import type {
  HarnessAdapter,
  HarnessError,
  HarnessResult,
  HarnessSession,
  HarnessSessionState,
} from "@codexhost/harness-adapter";
import { MappingStoreError } from "@codexhost/mapping-store";
import {
  mapExternalThreadHarnessError,
  transportModelIdForHarness,
  type ExternalThreadRpcError,
  type JsonObject,
} from "@codexhost/protocol-core";
import {
  DEEP_SEEK_NATIVE_SESSION_CANDIDATES_MAX_LENGTH,
  harnessIdSchema,
  nativeSessionRefSchema,
  type DeepSeekNativeSessionCandidate,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

import { DELEGATION_THREAD_ID_ENV } from "./delegation-types.js";
import {
  createExternalThreadRecordInput,
  externalThreadValue,
  type ExternalThreadRepository,
} from "./external-thread-repository.js";
import type { ExternalThread, ExternalThreadRuntime } from "./external-thread-runtime.js";

const deepSeekHarnessId = harnessIdSchema.parse("deepseek-harness");

export interface DeepSeekNativeSessionLinkError extends ExternalThreadRpcError {
  retryable: boolean;
}

export type DeepSeekNativeSessionCandidatesResult =
  | { ok: true; candidates: DeepSeekNativeSessionCandidate[] }
  | { ok: false; error: DeepSeekNativeSessionLinkError };

export type DeepSeekNativeSessionLinkResult =
  | { ok: true; linked: ExternalThread; thread: JsonObject }
  | { ok: false; error: DeepSeekNativeSessionLinkError };

interface DeepSeekNativeSessionAdapter extends HarnessAdapter {
  listNativeSessionCandidates(
    cwd: string,
  ): Promise<HarnessResult<DeepSeekNativeSessionCandidate[]>>;
}

function deepSeekAdapter(adapter: HarnessAdapter | undefined): DeepSeekNativeSessionAdapter | null {
  return adapter?.harnessId === deepSeekHarnessId &&
    typeof (adapter as { listNativeSessionCandidates?: unknown }).listNativeSessionCandidates ===
      "function"
    ? (adapter as DeepSeekNativeSessionAdapter)
    : null;
}

function harnessError(error: HarnessError, operation: "read" | "resume") {
  return { ...mapExternalThreadHarnessError(error, operation), retryable: error.retryable };
}

function fixedError(
  code: number,
  message: string,
  retryable: boolean,
): DeepSeekNativeSessionLinkError {
  return { code, message, retryable };
}

class DeepSeekNativeSessionValidationError extends Error {}

function linkFailure(error: unknown): DeepSeekNativeSessionLinkError {
  if (
    error instanceof MappingStoreError &&
    (error.code === "DUPLICATE_NATIVE_SESSION" || error.code === "MAPPING_CONFLICT")
  ) {
    return fixedError(-32082, "DeepSeek Native Session is already linked", false);
  }
  if (error instanceof MappingStoreError) {
    return fixedError(-32081, "DeepSeek Native Session link could not be persisted", true);
  }
  return fixedError(
    -32076,
    error instanceof DeepSeekNativeSessionValidationError
      ? error.message
      : "DeepSeek Native Session link failed",
    false,
  );
}

function isMapped(
  records: Awaited<ReturnType<ExternalThreadRepository["list"]>>,
  nativeSessionId: string,
): boolean {
  return records.some(
    (record) =>
      !record.subagent &&
      record.nativeSessionRef?.harnessId === deepSeekHarnessId &&
      record.nativeSessionRef.nativeSessionId === nativeSessionId,
  );
}

function confirmedState(
  session: HarnessSession,
  snapshotState: HarnessSessionState | undefined,
): HarnessSessionState {
  return { ...session.initialState, ...snapshotState };
}

function sameCwd(left: string, right: string): boolean {
  return (
    nodePath.isAbsolute(left) &&
    nodePath.isAbsolute(right) &&
    nodePath.relative(nodePath.resolve(left), nodePath.resolve(right)) === ""
  );
}

export class DeepSeekNativeSessionLinker {
  readonly #adapter: DeepSeekNativeSessionAdapter | null;
  readonly #diagnose: (error: unknown) => void;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #links = new Set<string>();
  readonly #repository: ExternalThreadRepository;
  readonly #runtime: ExternalThreadRuntime;

  constructor(input: {
    adapter: HarnessAdapter | undefined;
    diagnose?: (error: unknown) => void;
    environment?: NodeJS.ProcessEnv;
    repository: ExternalThreadRepository;
    runtime: ExternalThreadRuntime;
  }) {
    this.#adapter = deepSeekAdapter(input.adapter);
    this.#diagnose = input.diagnose ?? (() => undefined);
    this.#environment = input.environment ?? process.env;
    this.#repository = input.repository;
    this.#runtime = input.runtime;
  }

  async candidates(cwd: string): Promise<DeepSeekNativeSessionCandidatesResult> {
    if (!nodePath.isAbsolute(cwd)) {
      return {
        ok: false,
        error: fixedError(-32602, "DeepSeek Native Session cwd is invalid", false),
      };
    }
    const adapter = this.#adapter;
    if (!adapter) {
      return {
        ok: false,
        error: fixedError(-32077, "DeepSeek Harness is unavailable", true),
      };
    }
    let listed: Awaited<ReturnType<DeepSeekNativeSessionAdapter["listNativeSessionCandidates"]>>;
    try {
      listed = await adapter.listNativeSessionCandidates(cwd);
    } catch {
      return {
        ok: false,
        error: fixedError(-32077, "DeepSeek Harness is unavailable", true),
      };
    }
    if (!listed.ok) return { ok: false, error: harnessError(listed.error, "read") };
    try {
      const records = await this.#repository.list();
      const candidates = listed.value.filter(
        ({ cwd: nativeCwd, nativeSessionId }) =>
          sameCwd(nativeCwd, cwd) && !isMapped(records, nativeSessionId),
      );
      if (candidates.length > DEEP_SEEK_NATIVE_SESSION_CANDIDATES_MAX_LENGTH) {
        return {
          ok: false,
          error: fixedError(-32076, "DeepSeek Session candidate list is too large", false),
        };
      }
      return {
        ok: true,
        candidates,
      };
    } catch {
      return {
        ok: false,
        error: fixedError(-32081, "DeepSeek Session mappings could not be read", true),
      };
    }
  }

  async link(cwd: string, nativeSessionId: string): Promise<DeepSeekNativeSessionLinkResult> {
    if (this.#links.has(nativeSessionId)) {
      return {
        ok: false,
        error: fixedError(-32072, "DeepSeek Native Session link is already in progress", true),
      };
    }
    this.#links.add(nativeSessionId);
    try {
      return await this.#link(cwd, nativeSessionId);
    } finally {
      this.#links.delete(nativeSessionId);
    }
  }

  async #link(cwd: string, nativeSessionId: string): Promise<DeepSeekNativeSessionLinkResult> {
    const discovered = await this.candidates(cwd);
    if (!discovered.ok) return discovered;
    const candidate = discovered.candidates.find(
      (session) => session.nativeSessionId === nativeSessionId,
    );
    if (!candidate) {
      return {
        ok: false,
        error: fixedError(
          -32079,
          "DeepSeek Native Session is no longer available for this workspace",
          false,
        ),
      };
    }
    if (candidate.running) {
      return {
        ok: false,
        error: fixedError(-32072, "DeepSeek Native Session is busy", true),
      };
    }
    const adapter = this.#adapter;
    if (!adapter) {
      return {
        ok: false,
        error: fixedError(-32077, "DeepSeek Harness is unavailable", true),
      };
    }

    let provisional;
    try {
      provisional = await this.#repository.createProvisional(
        createExternalThreadRecordInput({
          harnessId: deepSeekHarnessId,
          cwd: candidate.cwd,
          ...(candidate.title ? { title: candidate.title } : {}),
          transportModelId: transportModelIdForHarness("deepseek-harness"),
          ephemeral: false,
          historyMode: "paginated",
        }),
      );
    } catch {
      return {
        ok: false,
        error: fixedError(-32081, "DeepSeek Native Session link could not be persisted", true),
      };
    }

    let session: HarnessSession | null = null;
    try {
      const nativeRef = nativeSessionRefSchema.parse({
        harnessId: deepSeekHarnessId,
        nativeSessionId,
        formatVersion: 1,
      });
      const opened = await adapter.open({
        kind: "resume",
        cwd: candidate.cwd,
        environment: {
          ...this.#environment,
          [DELEGATION_THREAD_ID_ENV]: provisional.hostThreadId,
        },
        nativeRef,
        knownTurnRefs: [],
      });
      if (!opened.ok) {
        await this.#repository
          .removeProvisional(provisional.hostThreadId)
          .catch((error) => this.#diagnose(error));
        return { ok: false, error: harnessError(opened.error, "resume") };
      }
      session = opened.value;
      const openedRef = nativeSessionRefSchema.safeParse(session.initialState.nativeRef);
      if (
        !openedRef.success ||
        openedRef.data.harnessId !== deepSeekHarnessId ||
        openedRef.data.nativeSessionId !== nativeSessionId
      ) {
        throw new DeepSeekNativeSessionValidationError(
          "DeepSeek resume returned another Native Session",
        );
      }
      const snapshot = await session.readSnapshot();
      if (!snapshot.ok) {
        await session.close().catch((error) => this.#diagnose(error));
        await this.#repository
          .removeProvisional(provisional.hostThreadId)
          .catch((error) => this.#diagnose(error));
        return { ok: false, error: harnessError(snapshot.error, "read") };
      }
      const state = confirmedState(session, snapshot.value.state);
      const stateRef = nativeSessionRefSchema.safeParse(state.nativeRef);
      if (
        !stateRef.success ||
        stateRef.data.harnessId !== deepSeekHarnessId ||
        stateRef.data.nativeSessionId !== nativeSessionId
      ) {
        throw new DeepSeekNativeSessionValidationError(
          "DeepSeek Snapshot state belongs to another Native Session",
        );
      }
      if (!state.effectiveModel) {
        throw new DeepSeekNativeSessionValidationError(
          "DeepSeek Native Session did not report its current Model",
        );
      }
      const aligned = await this.#repository.commitDerivedSnapshot(
        provisional,
        openedRef.data as NativeSessionRef,
        snapshot.value,
      );
      const thread = externalThreadValue({
        record: aligned.record,
        turns: aligned.turns,
        sessionId: aligned.record.hostThreadId,
      });
      const linked = this.#runtime.register({
        record: aligned.record,
        session,
        sessionId: aligned.record.hostThreadId,
        thread,
        turns: aligned.turns,
        restoredState: state,
      });
      return { ok: true, linked, thread };
    } catch (error) {
      this.#runtime.remove(provisional.hostThreadId);
      await session?.close().catch((closeError) => this.#diagnose(closeError));
      await this.#repository
        .removeThread(provisional.hostThreadId)
        .catch((removeError) => this.#diagnose(removeError));
      return { ok: false, error: linkFailure(error) };
    }
  }
}
