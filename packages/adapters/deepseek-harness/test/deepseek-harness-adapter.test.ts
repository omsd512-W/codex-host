import type {
  HarnessAdapter,
  HarnessInspection,
  HarnessResult,
  HarnessSession,
  InspectHarnessInput,
} from "@codexhost/harness-adapter";
import { harnessIdSchema, type DeepSeekModernSessionCandidate } from "@codexhost/shared-contracts";
import { nativeSessionRefSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DeepSeekHarnessAdapter } from "../src/deepseek-harness-adapter.js";
import {
  classifyDeepSeekVersionOutput,
  type DeepSeekExecutableGeneration,
} from "../src/generation-selector.js";
import {
  DEEPSEEK_V012_PROFILE,
  DEEPSEEK_V013_PROFILE,
  type DeepSeekModernProfile,
} from "../src/profiles/profile.js";

const readyInspection: HarnessInspection = {
  status: "ready",
  catalog: { models: [], thinkingOptions: [] },
  capabilities: {
    configuration: {
      selectModel: false,
      selectThinkingOption: false,
      selectPermissionMode: false,
      permissionModeScope: "live",
    },
    history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
  },
};

function executable(profile: DeepSeekModernProfile): DeepSeekExecutableGeneration {
  return {
    generation: "modern",
    version: profile.version,
    profile,
    command: { command: "resolved-dsh", arguments: ["--offline"], kind: "npx" },
  };
}

class FakeAdapter implements HarnessAdapter {
  readonly harnessId = harnessIdSchema.parse("deepseek-harness");
  readonly sessionImport = {
    listCandidates: async (): Promise<HarnessResult<DeepSeekModernSessionCandidate[]>> => ({
      ok: true,
      value: this.candidates,
    }),
  };
  closeCalls = 0;
  inspectCalls = 0;

  constructor(
    readonly profile: DeepSeekModernProfile,
    readonly candidates: DeepSeekModernSessionCandidate[] = [],
    readonly inspectResult: (input?: InspectHarnessInput) => Promise<HarnessInspection> = () =>
      Promise.resolve(readyInspection),
    readonly closeResult: () => Promise<void> = () => Promise.resolve(),
  ) {}

  inspect(input?: InspectHarnessInput): Promise<HarnessInspection> {
    this.inspectCalls += 1;
    return this.inspectResult(input);
  }

  open(): Promise<HarnessResult<HarnessSession>> {
    return Promise.resolve({ ok: true, value: {} as HarnessSession });
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    return this.closeResult();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DeepSeek exact profile selector", () => {
  it.each([DEEPSEEK_V012_PROFILE, DEEPSEEK_V013_PROFILE])(
    "passes $version to one managed profile for the Adapter lifetime",
    async (profile) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.reject(new Error("closed"))),
      );
      const delegate = new FakeAdapter(profile);
      const probeExecutable = vi.fn(() => Promise.resolve(executable(profile)));
      const createModernAdapter = vi.fn(() => delegate);
      const adapter = new DeepSeekHarnessAdapter({}, { probeExecutable, createModernAdapter });

      const expectedVersionSummary = {
        detected: `dsh-v${profile.version}`,
        supported: ["dsh-v0.1.3-rc.1", "dsh-v0.1.2-rc.1"],
        recommended: "dsh-v0.1.3-rc.1",
      };
      await expect(adapter.inspect()).resolves.toEqual({
        ...readyInspection,
        versionSummary: expectedVersionSummary,
      });
      await expect(adapter.inspect({ refresh: true })).resolves.toEqual({
        ...readyInspection,
        versionSummary: expectedVersionSummary,
      });
      expect(probeExecutable).toHaveBeenCalledOnce();
      expect(createModernAdapter).toHaveBeenCalledOnce();
      expect(createModernAdapter).toHaveBeenCalledWith(
        expect.objectContaining({
          profile,
          command: "resolved-dsh",
          commandArguments: ["--offline"],
        }),
      );
      await adapter.close();
      expect(delegate.closeCalls).toBe(1);
    },
  );

  it.each([
    [DEEPSEEK_V012_PROFILE, undefined],
    [DEEPSEEK_V013_PROFILE, { dshVersion: "0.1.3-rc.1" }],
  ] as const)("writes the selected Session locator", async (profile, locator) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("closed"))),
    );
    const candidate = {
      nativeSessionId: "native",
      cwd: "/project",
      title: "Session",
      updatedAt: 1,
      running: false,
    };
    const delegate = new FakeAdapter(profile, [candidate]);
    const adapter = new DeepSeekHarnessAdapter(
      {},
      {
        probeExecutable: () => Promise.resolve(executable(profile)),
        createModernAdapter: () => delegate,
      },
    );

    await expect(adapter.sessionImport.resolveCandidate("native")).resolves.toEqual({
      ok: true,
      value: {
        candidate,
        nativeRef: {
          harnessId: "deepseek-harness",
          nativeSessionId: "native",
          formatVersion: 1,
          ...(locator === undefined ? {} : { locator }),
        },
      },
    });
    await adapter.close();
  });

  it("returns an exact unsupported diagnostic before creating a profile", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("closed"))),
    );
    const createModernAdapter = vi.fn();
    const adapter = new DeepSeekHarnessAdapter(
      {},
      {
        probeExecutable: async () => ({
          ...classifyDeepSeekVersionOutput("0.1.1-rc.2\n"),
          command: executable(DEEPSEEK_V012_PROFILE).command,
        }),
        createModernAdapter,
      },
    );

    await expect(adapter.inspect()).resolves.toMatchObject({
      status: "unavailable",
      error: {
        code: "unsupported",
        retryable: false,
        message: expect.stringContaining("dsh-v0.1.1-rc.2"),
      },
      versionSummary: {
        detected: "dsh-v0.1.1-rc.2",
        supported: ["dsh-v0.1.3-rc.1", "dsh-v0.1.2-rc.1"],
        recommended: "dsh-v0.1.3-rc.1",
      },
    });
    const nativeRef = nativeSessionRefSchema.parse({
      harnessId: "deepseek-harness",
      nativeSessionId: "legacy",
      formatVersion: 1,
    });
    for (const input of [
      { kind: "create", cwd: "/project" },
      { kind: "resume", cwd: "/project", nativeRef },
    ] as const) {
      await expect(adapter.open(input)).resolves.toMatchObject({
        ok: false,
        error: { code: "unsupported", message: expect.stringContaining("升级") },
      });
    }
    await expect(adapter.sessionImport.listCandidates()).resolves.toMatchObject({
      ok: false,
      error: { code: "unsupported" },
    });
    expect(createModernAdapter).not.toHaveBeenCalled();
    await adapter.close();
  });

  it("identifies an existing authenticated managed Web instance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response("dsh web authentication required; reopen the URL printed by dsh web.\n", {
            status: 401,
            headers: {
              "cache-control": "no-store",
              "content-type": "text/plain; charset=utf-8",
            },
          }),
        ),
      ),
    );
    const createModernAdapter = vi.fn();
    const adapter = new DeepSeekHarnessAdapter(
      {},
      {
        probeExecutable: () => Promise.resolve(executable(DEEPSEEK_V013_PROFILE)),
        createModernAdapter,
      },
    );

    await expect(adapter.inspect()).resolves.toMatchObject({
      status: "unavailable",
      error: {
        code: "authenticationRequired",
        diagnostic: "externalModernWeb",
        stage: "wire-handshake",
      },
    });
    expect(createModernAdapter).not.toHaveBeenCalled();
  });

  it("closes one candidate while its inspection is pending", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("closed"))),
    );
    const inspection = Promise.withResolvers<HarnessInspection>();
    const delegate = new FakeAdapter(DEEPSEEK_V013_PROFILE, [], () => inspection.promise);
    const adapter = new DeepSeekHarnessAdapter(
      {},
      {
        probeExecutable: () => Promise.resolve(executable(DEEPSEEK_V013_PROFILE)),
        createModernAdapter: () => delegate,
      },
    );

    const pending = adapter.inspect();
    await vi.waitFor(() => expect(delegate.inspectCalls).toBe(1));
    await adapter.close();
    await expect(pending).resolves.toMatchObject({ status: "unavailable" });
    expect(delegate.closeCalls).toBe(1);
    inspection.resolve(readyInspection);
  });
});
