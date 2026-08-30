import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HarnessError, HarnessResult } from "@codexhost/harness-adapter";
import { FakeHarnessAdapter, FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import { MappingStore, MappingStoreError } from "@codexhost/mapping-store";
import { decodeExternalTransportSelection, type ExternalHarnessId } from "@codexhost/protocol-core";
import {
  harnessIdSchema,
  harnessPermissionModeCatalogSchema,
  hostTurnIdSchema,
  type DeepSeekNativeSessionCandidate,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DeepSeekNativeSessionLinker } from "../src/deepseek-native-session-link.js";
import { ExternalThreadRepository } from "../src/external-thread-repository.js";
import { ExternalThreadRuntime } from "../src/external-thread-runtime.js";

const deepSeekHarnessId = harnessIdSchema.parse("deepseek-harness");
const deepSeekPermissionModes = harnessPermissionModeCatalogSchema.parse({
  modes: [
    { id: "ask", label: "Ask" },
    { id: "full", label: "Full access" },
  ],
  defaultModeId: "ask",
});
const temporaryDirectories: string[] = [];

class CandidateAdapter extends FakeHarnessAdapter {
  candidates: DeepSeekNativeSessionCandidate[] = [];
  listError: HarnessError | null = null;
  readonly candidateCalls: string[] = [];

  constructor() {
    super(deepSeekHarnessId, undefined, true, true, null, deepSeekPermissionModes);
  }

  async listNativeSessionCandidates(
    cwd: string,
  ): Promise<HarnessResult<DeepSeekNativeSessionCandidate[]>> {
    this.candidateCalls.push(cwd);
    return this.listError
      ? { ok: false, error: this.listError }
      : { ok: true, value: structuredClone(this.candidates) };
  }
}

class IndependentCandidateAdapter extends CandidateAdapter {
  constructor(
    candidate: DeepSeekNativeSessionCandidate,
    private readonly resumedSession: FakeHarnessSession,
  ) {
    super();
    this.candidates = [candidate];
  }

  override async open(input: Parameters<CandidateAdapter["open"]>[0]) {
    if (input.kind === "resume") return { ok: true as const, value: this.resumedSession };
    return super.open(input);
  }
}

async function fixture(turnCount = 1) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-dsh-link-"));
  temporaryDirectories.push(directory);
  const store = new MappingStore({ directory });
  const repository = new ExternalThreadRepository(store);
  await repository.initialize();
  const adapter = new CandidateAdapter();
  const created = await adapter.open({ kind: "create", cwd: path.resolve("workspace") });
  if (!created.ok || !(created.value instanceof FakeHarnessSession)) {
    throw new Error("Fake DeepSeek Session did not open");
  }
  const session = created.value;
  for (let index = 0; index < turnCount; index += 1) {
    const started = await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse(`seed-turn-${index}`),
      input: [{ type: "text", text: `seed ${index}` }],
    });
    if (!started.ok) throw new Error(started.error.message);
    session.appendText(`answer ${index}`);
    session.succeedTurn();
  }
  const nativeSessionId = session.initialState.nativeRef?.nativeSessionId;
  if (!nativeSessionId) throw new Error("Fake DeepSeek Session has no Native identity");
  const candidate: DeepSeekNativeSessionCandidate = {
    nativeSessionId,
    title: "Native title",
    updatedAt: Date.now(),
    cwd: path.resolve("workspace"),
    running: false,
    blank: turnCount === 0,
  };
  adapter.candidates = [candidate];
  const adapters = new Map<ExternalHarnessId, CandidateAdapter>([["deepseek-harness", adapter]]);
  const runtime = new ExternalThreadRuntime({
    adapters,
    repository,
    consumeOutputs: async () => undefined,
    diagnose: () => undefined,
  });
  const linker = new DeepSeekNativeSessionLinker({ adapter, repository, runtime });
  return { adapter, candidate, directory, linker, repository, runtime, session, store };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("DeepSeekNativeSessionLinker", () => {
  it("links a full Snapshot with native state and stable later alignment", async () => {
    const setup = await fixture(2);
    const open = vi.spyOn(setup.adapter, "open");

    const result = await setup.linker.link(setup.candidate.cwd, setup.candidate.nativeSessionId);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    const record = await setup.repository.find(result.linked.id);
    expect(record).toMatchObject({
      state: "ready",
      cwd: setup.candidate.cwd,
      title: "Native title",
      nativeSessionRef: { nativeSessionId: setup.candidate.nativeSessionId },
    });
    expect(record?.turnMappings).toHaveLength(2);
    expect(result.thread.turns).toHaveLength(2);
    const resumeInput = open.mock.calls.at(-1)?.[0];
    expect(resumeInput).toMatchObject({
      kind: "resume",
      cwd: setup.candidate.cwd,
      nativeRef: { nativeSessionId: setup.candidate.nativeSessionId },
    });
    expect(resumeInput).not.toHaveProperty("model");
    expect(resumeInput).not.toHaveProperty("thinkingOptionId");
    expect(resumeInput).not.toHaveProperty("permissionModeId");
    const selection = decodeExternalTransportSelection(
      "deepseek-harness",
      record?.transportModelId,
    );
    expect(selection?.model).toBeUndefined();
    expect(selection?.permissionModeId).toBeUndefined();
    expect(result.linked.stateObserver.state).toMatchObject(setup.session.state);

    const oldTurnIds = record?.turnMappings.map(({ hostTurnId }) => hostTurnId) ?? [];
    const started = await setup.session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("native-later"),
      input: [{ type: "text", text: "later" }],
    });
    if (!started.ok) throw new Error(started.error.message);
    setup.session.succeedTurn();
    expect(await setup.runtime.refresh(result.linked)).toBeNull();
    expect(
      result.linked.record.turnMappings.slice(0, 2).map(({ hostTurnId }) => hostTurnId),
    ).toEqual(oldTurnIds);
    expect(result.linked.record.turnMappings).toHaveLength(3);
    await setup.repository.close();
  });

  it("links a legal empty Native Session", async () => {
    const setup = await fixture(0);
    const result = await setup.linker.link(setup.candidate.cwd, setup.candidate.nativeSessionId);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.linked.record).toMatchObject({ state: "ready", turnMappings: [] });
    expect(result.thread.turns).toEqual([]);
    await setup.repository.close();
  });

  it("cold-restores the latest Native state without replaying persisted defaults", async () => {
    const setup = await fixture(0);
    const linked = await setup.linker.link(setup.candidate.cwd, setup.candidate.nativeSessionId);
    if (!linked.ok) throw new Error(linked.error.message);
    const latestModel = setup.adapter.catalog.models[1]?.ref;
    const latestThinking = setup.adapter.catalog.thinkingOptions.at(-1)?.id;
    const latestPermission = deepSeekPermissionModes.modes[1]?.id;
    const nativeRef = setup.session.initialState.nativeRef;
    if (!latestModel || !latestThinking || !latestPermission || !nativeRef) {
      throw new Error("Fake catalog or Session lacks alternate state");
    }
    setup.session.setStateForSnapshot({
      nativeRef,
      effectiveModel: latestModel,
      effectiveThinkingOptionId: latestThinking,
      effectivePermissionModeId: latestPermission,
    });
    const execute = vi.spyOn(setup.session, "execute");
    setup.runtime.clear();
    await setup.repository.close();

    const restartedStore = new MappingStore({ directory: setup.directory, instanceId: "restart" });
    const restartedRepository = new ExternalThreadRepository(restartedStore);
    await restartedRepository.initialize();
    const restartedRuntime = new ExternalThreadRuntime({
      adapters: new Map<ExternalHarnessId, CandidateAdapter>([["deepseek-harness", setup.adapter]]),
      repository: restartedRepository,
      consumeOutputs: async () => undefined,
      diagnose: () => undefined,
    });

    const resolved = await restartedRuntime.resolve(linked.linked.id);

    expect(resolved.kind).toBe("external");
    if (resolved.kind !== "external") throw new Error("Linked Thread did not cold restore");
    expect(resolved.thread.stateObserver.state).toMatchObject({
      effectiveModel: latestModel,
      effectiveThinkingOptionId: latestThinking,
      effectivePermissionModeId: latestPermission,
    });
    expect(execute).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "permissionMode.select" }),
    );
    await restartedRepository.close();
  });

  it("excludes mapped Sessions from discovery and rejects a stale selection", async () => {
    const setup = await fixture(0);
    const first = await setup.linker.link(setup.candidate.cwd, setup.candidate.nativeSessionId);
    expect(first.ok).toBe(true);

    const candidates = await setup.linker.candidates(setup.candidate.cwd);
    expect(candidates).toEqual({ ok: true, candidates: [] });
    const repeated = await setup.linker.link(setup.candidate.cwd, setup.candidate.nativeSessionId);
    expect(repeated).toMatchObject({ ok: false, error: { code: -32079, retryable: false } });
    await setup.repository.close();
  });

  it("fails closed when a discovered Session disappears or becomes busy", async () => {
    const setup = await fixture(0);
    expect((await setup.linker.candidates(setup.candidate.cwd)).ok).toBe(true);
    setup.adapter.candidates = [];
    expect(
      await setup.linker.link(setup.candidate.cwd, setup.candidate.nativeSessionId),
    ).toMatchObject({ ok: false, error: { code: -32079, retryable: false } });

    setup.adapter.candidates = [{ ...setup.candidate, running: true }];
    expect(
      await setup.linker.link(setup.candidate.cwd, setup.candidate.nativeSessionId),
    ).toMatchObject({ ok: false, error: { code: -32072, retryable: true } });
    await setup.repository.close();
  });

  it("rechecks candidate cwd instead of trusting Adapter output", async () => {
    const setup = await fixture(0);
    setup.adapter.candidates = [{ ...setup.candidate, cwd: path.resolve("other-workspace") }];

    expect(await setup.linker.candidates(setup.candidate.cwd)).toEqual({
      ok: true,
      candidates: [],
    });
    expect(
      await setup.linker.link(setup.candidate.cwd, setup.candidate.nativeSessionId),
    ).toMatchObject({ ok: false, error: { code: -32079, retryable: false } });
    await setup.repository.close();
  });

  it("single-flights concurrent links for one Native Session", async () => {
    const setup = await fixture(0);
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const list = vi
      .spyOn(setup.adapter, "listNativeSessionCandidates")
      .mockImplementationOnce(async () => {
        await blocked;
        return { ok: true, value: [setup.candidate] };
      });

    const first = setup.linker.link(setup.candidate.cwd, setup.candidate.nativeSessionId);
    await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
    const duplicate = await setup.linker.link(setup.candidate.cwd, setup.candidate.nativeSessionId);
    expect(duplicate).toMatchObject({ ok: false, error: { code: -32072, retryable: true } });
    release?.();
    expect((await first).ok).toBe(true);
    await setup.repository.close();
  });

  it("lets Mapping Store choose one winner across concurrent Linkers", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-dsh-link-race-"));
    temporaryDirectories.push(directory);
    const store = new MappingStore({ directory });
    const repository = new ExternalThreadRepository(store);
    await repository.initialize();
    const cwd = path.resolve("race-workspace");
    const nativeRef = {
      harnessId: deepSeekHarnessId,
      nativeSessionId: "shared-native-session",
      formatVersion: 1 as const,
    };
    const candidate: DeepSeekNativeSessionCandidate = {
      nativeSessionId: nativeRef.nativeSessionId,
      title: null,
      updatedAt: Date.now(),
      cwd,
      running: false,
      blank: true,
    };
    const catalogAdapter = new CandidateAdapter();
    const model = catalogAdapter.catalog.defaultModel;
    const firstSession = new FakeHarnessSession(
      deepSeekHarnessId,
      catalogAdapter.catalog,
      model,
      nativeRef,
      { turns: [] },
      true,
      cwd,
    );
    const secondSession = new FakeHarnessSession(
      deepSeekHarnessId,
      catalogAdapter.catalog,
      model,
      nativeRef,
      { turns: [] },
      true,
      cwd,
    );
    const firstAdapter = new IndependentCandidateAdapter(candidate, firstSession);
    const secondAdapter = new IndependentCandidateAdapter(candidate, secondSession);
    const firstRuntime = new ExternalThreadRuntime({
      adapters: new Map<ExternalHarnessId, IndependentCandidateAdapter>([
        ["deepseek-harness", firstAdapter],
      ]),
      repository,
      consumeOutputs: async () => undefined,
      diagnose: () => undefined,
    });
    const secondRuntime = new ExternalThreadRuntime({
      adapters: new Map<ExternalHarnessId, IndependentCandidateAdapter>([
        ["deepseek-harness", secondAdapter],
      ]),
      repository,
      consumeOutputs: async () => undefined,
      diagnose: () => undefined,
    });
    const firstLinker = new DeepSeekNativeSessionLinker({
      adapter: firstAdapter,
      repository,
      runtime: firstRuntime,
    });
    const secondLinker = new DeepSeekNativeSessionLinker({
      adapter: secondAdapter,
      repository,
      runtime: secondRuntime,
    });
    const bothAtCommit = Promise.withResolvers<undefined>();
    let arrivals = 0;
    const originalCommit = repository.commitDerivedSnapshot.bind(repository);
    vi.spyOn(repository, "commitDerivedSnapshot").mockImplementation(async (...arguments_) => {
      arrivals += 1;
      if (arrivals === 2) bothAtCommit.resolve(undefined);
      await bothAtCommit.promise;
      return originalCommit(...arguments_);
    });

    const results = await Promise.all([
      firstLinker.link(cwd, nativeRef.nativeSessionId),
      secondLinker.link(cwd, nativeRef.nativeSessionId),
    ]);

    expect(results.filter(({ ok }) => ok)).toHaveLength(1);
    expect(results.find(({ ok }) => !ok)).toMatchObject({
      ok: false,
      error: { code: -32082, retryable: false },
    });
    expect((await repository.list()).filter(({ state }) => state === "ready")).toHaveLength(1);
    await repository.close();
  });

  it.each(["readSnapshot", "commit", "register"] as const)(
    "rolls back Host state when %s fails",
    async (stage) => {
      const setup = await fixture(0);
      const close = vi.spyOn(setup.session, "close");
      if (stage === "readSnapshot") {
        vi.spyOn(setup.session, "readSnapshot").mockResolvedValueOnce({
          ok: false,
          error: { code: "nativeFailure", message: "synthetic read failure", retryable: true },
        });
      } else if (stage === "commit") {
        vi.spyOn(setup.repository, "commitDerivedSnapshot").mockRejectedValueOnce(
          new MappingStoreError("IO_ERROR", "synthetic commit failure"),
        );
      } else {
        vi.spyOn(setup.runtime, "register").mockImplementationOnce(() => {
          throw new Error("synthetic registration failure");
        });
      }

      const result = await setup.linker.link(setup.candidate.cwd, setup.candidate.nativeSessionId);

      expect(result).toMatchObject({ ok: false });
      expect(await setup.repository.list()).toEqual([]);
      expect(close).toHaveBeenCalledOnce();
      await setup.repository.close();
    },
  );

  it("leaves no record when provisional creation fails", async () => {
    const setup = await fixture(0);
    vi.spyOn(setup.repository, "createProvisional").mockRejectedValueOnce(
      new Error("synthetic provisional failure"),
    );
    const close = vi.spyOn(setup.session, "close");

    expect(
      await setup.linker.link(setup.candidate.cwd, setup.candidate.nativeSessionId),
    ).toMatchObject({ ok: false, error: { code: -32081, retryable: true } });
    expect(await setup.repository.list()).toEqual([]);
    expect(close).not.toHaveBeenCalled();
    await setup.repository.close();
  });

  it("removes provisional state when native resume rejects", async () => {
    const setup = await fixture(0);
    vi.spyOn(setup.adapter, "open").mockResolvedValueOnce({
      ok: false,
      error: { code: "sessionNotFound", message: "vanished", retryable: false },
    });
    const close = vi.spyOn(setup.session, "close");

    expect(
      await setup.linker.link(setup.candidate.cwd, setup.candidate.nativeSessionId),
    ).toMatchObject({ ok: false, error: { code: -32079, retryable: false } });
    expect(await setup.repository.list()).toEqual([]);
    expect(close).not.toHaveBeenCalled();
    await setup.repository.close();
  });

  it("diagnoses cleanup failures without replacing the primary link error", async () => {
    const setup = await fixture(0);
    const diagnose = vi.fn();
    const linker = new DeepSeekNativeSessionLinker({
      adapter: setup.adapter,
      diagnose,
      repository: setup.repository,
      runtime: setup.runtime,
    });
    const cleanupError = new Error("synthetic close failure");
    vi.spyOn(setup.session, "readSnapshot").mockResolvedValueOnce({
      ok: false,
      error: { code: "nativeFailure", message: "primary read failure", retryable: true },
    });
    vi.spyOn(setup.session, "close").mockRejectedValueOnce(cleanupError);

    expect(await linker.link(setup.candidate.cwd, setup.candidate.nativeSessionId)).toMatchObject({
      ok: false,
      error: { message: "External Thread read failed", retryable: true },
    });
    expect(diagnose).toHaveBeenCalledWith(cleanupError);
    expect(await setup.repository.list()).toEqual([]);
    await setup.repository.close();
  });

  it("reports a Mapping Store Native Session race as a non-retryable conflict", async () => {
    const setup = await fixture(0);
    vi.spyOn(setup.repository, "commitDerivedSnapshot").mockRejectedValueOnce(
      new MappingStoreError("DUPLICATE_NATIVE_SESSION", "synthetic mapping race"),
    );

    expect(
      await setup.linker.link(setup.candidate.cwd, setup.candidate.nativeSessionId),
    ).toMatchObject({ ok: false, error: { code: -32082, retryable: false } });
    expect(await setup.repository.list()).toEqual([]);
    await setup.repository.close();
  });

  it("reports an unexpected resumed identity as a non-retryable protocol failure", async () => {
    const setup = await fixture(0);
    Object.defineProperty(setup.session, "initialState", {
      configurable: true,
      value: {
        ...setup.session.initialState,
        nativeRef: {
          harnessId: deepSeekHarnessId,
          nativeSessionId: "another-native-session",
          formatVersion: 1,
        },
      },
    });

    expect(
      await setup.linker.link(setup.candidate.cwd, setup.candidate.nativeSessionId),
    ).toMatchObject({ ok: false, error: { code: -32076, retryable: false } });
    expect(await setup.repository.list()).toEqual([]);
    await setup.repository.close();
  });

  it("preserves retryability from candidate transport failures", async () => {
    const setup = await fixture(0);
    setup.adapter.listError = {
      code: "unavailable",
      message: "DSH unavailable",
      retryable: true,
    };

    expect(await setup.linker.candidates(setup.candidate.cwd)).toMatchObject({
      ok: false,
      error: { code: -32077, retryable: true },
    });
    await setup.repository.close();
  });
});
