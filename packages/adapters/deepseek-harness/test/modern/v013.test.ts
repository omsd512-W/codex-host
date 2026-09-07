import { describe, expect, it, vi } from "vitest";

import {
  matchesModernForkHistory,
  ModernHistoryError,
  projectModernHistory,
  resolveModernForkBoundary,
} from "../../src/modern/history.js";
import {
  ModernJournalDesyncError,
  openModernJournal,
  type ModernJournalEvent,
  type ModernJournalRemote,
} from "../../src/modern/journal.js";
import { DEEPSEEK_V012_PROFILE, DEEPSEEK_V013_PROFILE } from "../../src/profiles/profile.js";
import {
  expandV013AssistantStream,
  parseV013AssistantBaseline,
  parseV013AssistantFrame,
} from "../../src/profiles/v013.js";
import type { ModernRemoteResult } from "../../src/modern/wire.js";

const SESSION_ID = "session-v013";
const CWD = String.raw`E:\Coding\Project\fixture`;

class FollowFeed implements AsyncIterable<unknown>, AsyncIterator<unknown> {
  readonly #items: IteratorResult<unknown>[] = [];
  #pending: ((value: IteratorResult<unknown>) => void) | undefined;
  #done = false;

  push(value: unknown): void {
    const item = { done: false as const, value };
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending) pending(item);
    else this.#items.push(item);
  }

  next(): Promise<IteratorResult<unknown>> {
    const item = this.#items.shift();
    if (item) return Promise.resolve(item);
    if (this.#done) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => {
      this.#pending = resolve;
    });
  }

  return(): Promise<IteratorResult<unknown>> {
    this.#done = true;
    this.#pending?.({ done: true, value: undefined });
    this.#pending = undefined;
    return Promise.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this;
  }
}

class FakeRemote implements ModernJournalRemote {
  readonly calls: Array<{
    readonly endpoint: string;
    readonly args: Readonly<Record<string, unknown>>;
  }> = [];

  constructor(readonly feed: FollowFeed) {}

  call<T>(): Promise<ModernRemoteResult<T>> {
    return Promise.reject(new Error("unexpected page call"));
  }

  openStream<T>(endpoint: string, args: Readonly<Record<string, unknown>>): AsyncIterable<T> {
    this.calls.push({ endpoint, args });
    return this.feed as AsyncIterable<T>;
  }
}

function event(
  seq: number,
  type: string,
  data: Record<string, unknown>,
  surface = false,
): ModernJournalEvent {
  return {
    type,
    seq,
    time: 1_000 + seq,
    data: data as never,
    ...(surface ? { surfaceOp: "append" as const } : {}),
  };
}

function record(value: ModernJournalEvent): Record<string, unknown> {
  return { type: "event", event: value };
}

function snapshot(
  events: readonly ModernJournalEvent[],
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const cursor = events.length - 1;
  return {
    type: "snapshot",
    header: {
      version: 2,
      id: SESSION_ID,
      createdAt: 1,
      cwd: CWD,
      isSeeded: false,
    },
    cursor,
    records: events.map(record),
    hasMore: false,
    projections: { asOfSeq: cursor, values: {} },
    assistantStream: { revision: 0 },
    ...overrides,
  };
}

function v013History(): ModernJournalEvent[] {
  return [
    event(0, "turn/start", { turn: 1 }),
    event(1, "step/start", { turn: 1, step: 1 }),
    event(
      2,
      "user/message",
      {
        id: "user-1",
        role: "user",
        content: [
          { type: "text", text: "hello" },
          {
            type: "file",
            attachment: { attachmentId: "sha256-file", name: "notes.txt", bytes: 5 },
          },
        ],
        source: { kind: "user", rpcId: "request-1" },
      },
      true,
    ),
    event(3, "assistant/attempt", {
      turn: 1,
      step: 1,
      stream: [
        {
          type: "chunk",
          time: 1_003,
          chunk: { type: "usage", usage: { inputTokens: 2, outputTokens: 1 } },
        },
      ],
    }),
    event(
      4,
      "assistant/message",
      {
        turn: 1,
        step: 1,
        message: {
          id: "assistant-1",
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          source: { kind: "model", provider: "deepseek", model: "deepseek-v4" },
        },
        stream: [{ type: "text-chunks", time0: 1_004, index: 0, dt: [], texts: ["done"] }],
        usage: { inputTokens: 3, outputTokens: 2 },
      },
      true,
    ),
    event(5, "session-log-deepseek/delivery-accepted", {
      sessionId: SESSION_ID,
      throughSeq: 4,
      sessionFormatVersion: 2,
    }),
    event(6, "step/end", { turn: 1, step: 1 }),
    event(7, "turn/end", { turn: 1, reason: { kind: "completed" } }),
  ];
}

describe("DeepSeek v0.1.3 candidate profile", () => {
  it("closes follow when a reconnect baseline exceeds the live buffer bound", async () => {
    const feed = new FollowFeed();
    const close = vi.spyOn(feed, "return");
    feed.push(
      snapshot([], {
        assistantStream: {
          revision: 2,
          activeAttempt: {
            attemptId: "a",
            startedAfterSeq: -1,
            turn: 1,
            step: 1,
            nextIndex: 1,
            stream: [{ type: "text-chunks", time0: 1, index: 0, dt: [], texts: ["a"] }],
          },
        },
      }),
    );
    await expect(
      openModernJournal(
        new FakeRemote(feed),
        { sessionId: SESSION_ID, cwd: CWD },
        { profile: DEEPSEEK_V013_PROFILE, maxBufferedLiveEvents: 1 },
      ),
    ).rejects.toMatchObject({ code: "limitExceeded" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("preserves alpha2 raw empty tool fragments while rejecting invalid compact runs", () => {
    const chunk = { type: "tool-call-delta", index: 0, id: "", name: "", argumentsDelta: "{" };
    expect(expandV013AssistantStream([{ type: "chunk", time: 1, chunk }])).toEqual([
      { time: 1, chunk },
    ]);
    expect(
      parseV013AssistantFrame({
        type: "chunk",
        attemptId: "a",
        revision: 2,
        index: 0,
        time: 1,
        chunk,
      }),
    ).toMatchObject({ chunk });
    expect(() =>
      expandV013AssistantStream([
        { type: "tool-call-chunks", time0: 1, index: 0, id: "", name: "", dt: [], args: ["{"] },
      ]),
    ).toThrow();
    expect(() => DEEPSEEK_V012_PROFILE.validateChunk(chunk)).toThrow();
  });

  it("reads alpha2 message feedback as log-only metadata and rejects it in v012", () => {
    const feedback = [
      event(0, "feedback/message-put", {
        sessionId: SESSION_ID,
        item: {
          messageId: "m",
          rating: "positive",
          version: "v1",
          createdAt: 1,
          updatedAt: 2,
          note: "useful",
        },
      }),
      event(1, "feedback/message-delete", { sessionId: SESSION_ID, messageId: "m" }),
    ];
    expect(
      projectModernHistory({
        sessionId: SESSION_ID,
        profile: DEEPSEEK_V013_PROFILE,
        events: feedback,
      }).snapshot.turns,
    ).toEqual([]);
    expect(() => projectModernHistory({ sessionId: SESSION_ID, events: feedback })).toThrow();
    for (const invalid of [
      { ...(feedback[0] as ModernJournalEvent), surfaceOp: "append" as const },
      event(0, "feedback/message-put", {
        sessionId: SESSION_ID,
        item: { messageId: "m", rating: "maybe", version: "v1", createdAt: 1, updatedAt: 2 },
      }),
      event(0, "feedback/message-delete", { sessionId: SESSION_ID }),
    ]) {
      expect(() =>
        projectModernHistory({
          sessionId: SESSION_ID,
          profile: DEEPSEEK_V013_PROFILE,
          events: [invalid],
        }),
      ).toThrow();
    }
  });

  it.each([DEEPSEEK_V012_PROFILE, DEEPSEEK_V013_PROFILE])(
    "accepts native fractional Hook durations in $version",
    (profile) => {
      const hook = {
        turn: 1,
        point: "PostToolUse",
        handlerId: "hook",
        decision: "pass",
        durationMs: 9.40504199999998,
      };
      expect(() =>
        projectModernHistory({
          sessionId: SESSION_ID,
          profile,
          events: [event(0, "hook/result", hook)],
        }),
      ).not.toThrow();
      for (const durationMs of [-1, Infinity, NaN, "9.4"]) {
        expect(() =>
          projectModernHistory({
            sessionId: SESSION_ID,
            profile,
            events: [event(0, "hook/result", { ...hook, durationMs })],
          }),
        ).toThrow();
      }
    },
  );

  it("expands compact Assistant streams without changing delta boundaries", () => {
    expect(
      expandV013AssistantStream([
        { type: "text-chunks", time0: 10, index: 0, dt: [2], texts: ["a", "b"] },
        {
          type: "tool-call-chunks",
          time0: 20,
          index: 1,
          dt: [1],
          id: "call-1",
          name: "write",
          args: ["{", "}"],
        },
      ]),
    ).toEqual([
      { time: 10, chunk: { type: "text-delta", index: 0, text: "a" } },
      { time: 12, chunk: { type: "text-delta", index: 0, text: "b" } },
      {
        time: 20,
        chunk: {
          type: "tool-call-delta",
          index: 1,
          id: "call-1",
          name: "write",
          argumentsDelta: "{",
        },
      },
      {
        time: 21,
        chunk: {
          type: "tool-call-delta",
          index: 1,
          id: "call-1",
          name: "write",
          argumentsDelta: "}",
        },
      },
    ]);
  });

  it.each([
    [[{ type: "text-chunks", time0: 1, index: 0, dt: [], texts: [] }]],
    [[{ type: "text-chunks", time0: 1, index: 0, dt: [1], texts: ["x"] }]],
    [[{ type: "chunk", time: 1, chunk: { type: "future" } }]],
    [[{ type: "chunk", time: 1, chunk: { type: "usage", usage: { value: Number.NaN } } }]],
    [[{ type: "chunk", time: 1, chunk: { type: "usage", usage: { value: undefined } } }]],
  ])("rejects malformed compact stream %j", (stream) => {
    expect(() => expandV013AssistantStream(stream)).toThrow(/v0\.1\.3/u);
  });

  it("requires a positive baseline revision for an active attempt", () => {
    expect(
      parseV013AssistantBaseline({
        revision: 1,
        activeAttempt: {
          attemptId: "attempt-1",
          startedAfterSeq: -1,
          turn: 1,
          step: 1,
          nextIndex: 0,
          stream: [],
        },
      }),
    ).toMatchObject({ revision: 1, activeAttempt: { nextIndex: 0, stream: [] } });
    expect(() =>
      parseV013AssistantBaseline({
        revision: 0,
        activeAttempt: {
          attemptId: "attempt-1",
          startedAfterSeq: 1,
          turn: 1,
          step: 1,
          nextIndex: 0,
          stream: [],
        },
      }),
    ).toThrow(/revision/u);
  });

  it("validates dense live frame fields", () => {
    expect(
      parseV013AssistantFrame({
        type: "chunk",
        attemptId: "attempt-1",
        revision: 2,
        index: 0,
        time: 10,
        chunk: { type: "text-delta", index: 0, text: "a" },
      }),
    ).toMatchObject({ type: "chunk", revision: 2, index: 0 });
    expect(() =>
      parseV013AssistantFrame({
        type: "chunk",
        attemptId: "attempt-1",
        revision: 2,
        index: 0,
        time: 10,
        chunk: { type: "future" },
      }),
    ).toThrow(/chunk/u);
  });

  it("opens v2 with assistant streaming and keeps transient frames outside the durable cursor", async () => {
    const feed = new FollowFeed();
    feed.push(snapshot([event(0, "fixture/event", { ok: true })]));
    const remote = new FakeRemote(feed);
    const journal = await openModernJournal(
      remote,
      { sessionId: SESSION_ID, cwd: CWD },
      { profile: DEEPSEEK_V013_PROFILE },
    );
    const live = journal.live[Symbol.asyncIterator]();
    feed.push({
      type: "assistant-stream",
      frame: {
        type: "start",
        attemptId: "attempt-1",
        revision: 1,
        startedAfterSeq: 0,
        turn: 1,
        step: 1,
      },
    });
    feed.push({ type: "event", event: event(1, "fixture/event", { ok: true }) });

    await expect(live.next()).resolves.toMatchObject({
      value: { type: "assistant-stream", frame: { type: "start", revision: 1 } },
    });
    await expect(live.next()).resolves.toMatchObject({ value: { seq: 1 } });
    expect(journal.cursor).toBe(0);
    expect(remote.calls[0]?.args).toEqual({
      request: {
        address: { kind: "session", sessionId: SESSION_ID },
        maxMessages: 200,
        assistantStream: true,
      },
    });
    await journal.close();
  });

  it("restores an active baseline before later revisions", async () => {
    const feed = new FollowFeed();
    feed.push(
      snapshot([], {
        assistantStream: {
          revision: 3,
          activeAttempt: {
            attemptId: "attempt-1",
            startedAfterSeq: -1,
            turn: 1,
            step: 1,
            nextIndex: 1,
            stream: [{ type: "text-chunks", time0: 10, index: 0, dt: [], texts: ["a"] }],
          },
        },
      }),
    );
    const journal = await openModernJournal(
      new FakeRemote(feed),
      { sessionId: SESSION_ID, cwd: CWD },
      { profile: DEEPSEEK_V013_PROFILE },
    );
    const live = journal.live[Symbol.asyncIterator]();
    await expect(live.next()).resolves.toMatchObject({
      value: { type: "assistant-stream", frame: { type: "start", attemptId: "attempt-1" } },
    });
    await expect(live.next()).resolves.toMatchObject({
      value: { type: "assistant-stream", frame: { type: "chunk", index: 0 } },
    });
    feed.push({
      type: "assistant-stream",
      frame: {
        type: "chunk",
        attemptId: "attempt-1",
        revision: 4,
        index: 1,
        time: 11,
        chunk: { type: "text-delta", index: 0, text: "b" },
      },
    });
    await expect(live.next()).resolves.toMatchObject({
      value: { type: "assistant-stream", frame: { revision: 4, index: 1 } },
    });
    await journal.close();
  });

  it("accepts revision one when a replacement Agent starts a new lifecycle", async () => {
    const feed = new FollowFeed();
    feed.push(snapshot([], { assistantStream: { revision: 3 } }));
    const journal = await openModernJournal(
      new FakeRemote(feed),
      { sessionId: SESSION_ID, cwd: CWD },
      { profile: DEEPSEEK_V013_PROFILE },
    );
    const live = journal.live[Symbol.asyncIterator]();
    feed.push({
      type: "assistant-stream",
      frame: {
        type: "start",
        attemptId: "replacement:1",
        revision: 1,
        startedAfterSeq: -1,
        turn: 1,
        step: 1,
      },
    });

    await expect(live.next()).resolves.toMatchObject({
      value: { type: "assistant-stream", frame: { type: "start", revision: 1 } },
    });
    await journal.close();
  });

  it("marks an Assistant revision gap for baseline recovery", async () => {
    const feed = new FollowFeed();
    feed.push(snapshot([], { assistantStream: { revision: 3 } }));
    const journal = await openModernJournal(
      new FakeRemote(feed),
      { sessionId: SESSION_ID, cwd: CWD },
      { profile: DEEPSEEK_V013_PROFILE },
    );
    const live = journal.live[Symbol.asyncIterator]();
    feed.push({
      type: "assistant-stream",
      frame: {
        type: "chunk",
        attemptId: "missed-start",
        revision: 5,
        index: 0,
        time: 10,
        chunk: { type: "text-delta", index: 0, text: "gap" },
      },
    });

    await expect(live.next()).rejects.toBeInstanceOf(ModernJournalDesyncError);
    await journal.close();
  });

  it("isolates v0 and v2 wire formats", async () => {
    const v0Feed = new FollowFeed();
    v0Feed.push(
      snapshot([], {
        header: { version: 0, id: SESSION_ID, createdAt: 1, cwd: CWD },
      }),
    );
    await expect(
      openModernJournal(
        new FakeRemote(v0Feed),
        { sessionId: SESSION_ID, cwd: CWD },
        { profile: DEEPSEEK_V013_PROFILE },
      ),
    ).rejects.toMatchObject({ code: "protocolError" });

    const v2Feed = new FollowFeed();
    v2Feed.push(snapshot([]));
    await expect(
      openModernJournal(
        new FakeRemote(v2Feed),
        { sessionId: SESSION_ID, cwd: CWD },
        { profile: DEEPSEEK_V012_PROFILE },
      ),
    ).rejects.toMatchObject({ code: "protocolError" });
  });

  it("projects retry Usage once per v2 settlement and emits v2 references", () => {
    const projection = projectModernHistory({
      sessionId: SESSION_ID,
      events: v013History(),
      profile: DEEPSEEK_V013_PROFILE,
    });

    expect(projection.snapshot.turns).toHaveLength(1);
    expect(projection.snapshot.turns[0]).toMatchObject({
      checkpoint: {
        checkpointId: "v2-turn-end:7",
        locator: { dshVersion: "0.1.3-rc.1" },
      },
      items: [{ item: { type: "agentMessage", text: "done" } }],
    });
    expect(projection.nativeRef).toMatchObject({
      formatVersion: 1,
      locator: { dshVersion: "0.1.3-rc.1" },
    });
    expect(projection.usage).toMatchObject({ inputTokens: 5, outputTokens: 3 });
  });

  it("accepts an empty migrated message stream but rejects v2 chunk events and provenance", () => {
    const history = v013History();
    const message = history[4] as ModernJournalEvent;
    const data = message.data as Record<string, unknown>;
    const migrated = projectModernHistory({
      sessionId: SESSION_ID,
      events: [
        ...history.slice(0, 4),
        { ...message, data: { ...data, stream: [] } as never },
        ...history.slice(5),
      ],
      profile: DEEPSEEK_V013_PROFILE,
    });
    expect(migrated.snapshot.turns[0]?.items).toMatchObject([
      { item: { type: "agentMessage", text: "done" } },
    ]);
    expect(() =>
      projectModernHistory({
        sessionId: SESSION_ID,
        events: [
          ...history.slice(0, 3),
          event(3, "assistant/chunk", {
            turn: 1,
            step: 1,
            chunk: { type: "text-delta", index: 0, text: "x" },
          }),
        ],
        profile: DEEPSEEK_V013_PROFILE,
      }),
    ).toThrow(ModernHistoryError);
    expect(() =>
      projectModernHistory({
        sessionId: SESSION_ID,
        events: [...history.slice(0, 4), { ...message, sourceEventSeqs: [1] }],
        profile: DEEPSEEK_V013_PROFILE,
      }),
    ).toThrow(ModernHistoryError);
  });

  it("uses the tagged v2 fork marker and rejects a v1 checkpoint namespace", () => {
    const source = v013History();
    const boundary = resolveModernForkBoundary(source, "v2-turn-end:7", DEEPSEEK_V013_PROFILE);
    expect(boundary?.atSeq).toBe(7);
    expect(resolveModernForkBoundary(source, "turn-end:7", DEEPSEEK_V013_PROFILE)).toBeNull();
    const child = [
      ...source,
      event(8, "session/end-seed", { inherited: true }),
      event(9, "agent-preset/selected", { agentPreset: "coding" }),
    ];
    expect(matchesModernForkHistory(source, child, DEEPSEEK_V013_PROFILE)).toBe(true);
    expect(
      matchesModernForkHistory(
        source,
        [...source, event(8, "session/end-seed", {})],
        DEEPSEEK_V013_PROFILE,
      ),
    ).toBe(false);
  });
});
