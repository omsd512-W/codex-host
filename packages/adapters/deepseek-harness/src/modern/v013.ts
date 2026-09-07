import type {
  ModernJournalEvent,
  ModernJournalHeader,
  ModernJournalJson,
  ModernJournalLiveItem,
  ModernJournalOpenRequest,
} from "./journal.js";

export const V013_JOURNAL_SNAPSHOT_KEYS = Object.freeze([
  "type",
  "header",
  "cursor",
  "records",
  "hasMore",
  "projections",
  "assistantStream",
]);

export class DeepSeekV013ProtocolError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "DeepSeekV013ProtocolError";
  }
}

export interface DeepSeekV013TimedChunk {
  readonly time: number;
  readonly chunk: Readonly<Record<string, ModernJournalJson>>;
}

export interface DeepSeekV013AssistantAttempt {
  readonly attemptId: string;
  readonly startedAfterSeq: number;
  readonly turn: number;
  readonly step: number;
  readonly nextIndex: number;
  readonly stream: readonly ModernJournalJson[];
}

export interface DeepSeekV013AssistantBaseline {
  readonly revision: number;
  readonly activeAttempt?: DeepSeekV013AssistantAttempt;
}

export type DeepSeekV013AssistantFrame =
  | {
      readonly type: "start";
      readonly attemptId: string;
      readonly revision: number;
      readonly startedAfterSeq: number;
      readonly turn: number;
      readonly step: number;
    }
  | {
      readonly type: "chunk";
      readonly attemptId: string;
      readonly revision: number;
      readonly index: number;
      readonly time: number;
      readonly chunk: Readonly<Record<string, ModernJournalJson>>;
    }
  | {
      readonly type: "end";
      readonly attemptId: string;
      readonly revision: number;
      readonly index: number;
      readonly outcome:
        | {
            readonly kind: "committed";
            readonly eventType: "assistant/message" | "assistant/attempt";
            readonly seq: number;
          }
        | { readonly kind: "abandoned" };
    };

export function parseV013JournalHeader(
  value: unknown,
  expected: ModernJournalOpenRequest,
): ModernJournalHeader {
  if (
    !isRecord(value) ||
    !onlyKeys(
      value,
      ["version", "id", "createdAt", "isSeeded"],
      ["cwd", "parentSession", "origin", "delegationDepth", "agentPreset"],
    ) ||
    value.version !== 2 ||
    value.id !== expected.sessionId ||
    !isNonNegativeSafeInteger(value.createdAt) ||
    Object.hasOwn(value, "cwd") !== (expected.cwd !== undefined) ||
    value.cwd !== expected.cwd ||
    typeof value.isSeeded !== "boolean" ||
    (Object.hasOwn(value, "parentSession") && typeof value.parentSession !== "string") ||
    (Object.hasOwn(value, "origin") && value.origin !== "subagent") ||
    (Object.hasOwn(value, "delegationDepth") && !isNonNegativeSafeInteger(value.delegationDepth)) ||
    (Object.hasOwn(value, "agentPreset") && typeof value.agentPreset !== "string")
  ) {
    throw invalid("journal snapshot header");
  }
  return value as unknown as ModernJournalHeader;
}

export function parseV013HistoryRecord(
  value: unknown,
  remainingEvents: number,
  parseEvent: (value: unknown) => ModernJournalEvent,
): ModernJournalEvent[] {
  if (remainingEvents < 1) throw invalid("journal event bound");
  if (!isRecord(value) || !onlyKeys(value, ["type", "event"]) || value.type !== "event") {
    throw invalid("journal history record");
  }
  return [parseEvent(value.event)];
}

export function parseV013LiveItem(
  value: unknown,
  parseEvent: (value: unknown) => ModernJournalEvent,
): ModernJournalLiveItem {
  if (!isRecord(value)) throw invalid("journal live frame");
  if (onlyKeys(value, ["type", "event"]) && value.type === "event") {
    return parseEvent(value.event);
  }
  if (onlyKeys(value, ["type", "frame"]) && value.type === "assistant-stream") {
    return { type: "assistant-stream", frame: parseV013AssistantFrame(value.frame) };
  }
  throw invalid("journal live frame");
}

export function parseV013AssistantBaseline(value: unknown): DeepSeekV013AssistantBaseline {
  if (!isRecord(value) || !onlyKeys(value, ["revision"], ["activeAttempt"])) {
    throw invalid("assistant stream baseline");
  }
  const revision = nonNegativeInteger(value.revision, "assistant stream baseline revision");
  if (value.activeAttempt === undefined) return { revision };
  if (revision === 0) throw invalid("assistant stream active baseline revision");
  const attempt = value.activeAttempt;
  if (
    !isRecord(attempt) ||
    !onlyKeys(attempt, ["attemptId", "startedAfterSeq", "turn", "step", "nextIndex", "stream"])
  ) {
    throw invalid("assistant stream baseline attempt");
  }
  const parsed: DeepSeekV013AssistantAttempt = {
    attemptId: identifier(attempt.attemptId, "assistant stream attemptId"),
    startedAfterSeq: cursor(attempt.startedAfterSeq, "assistant stream startedAfterSeq"),
    turn: positiveInteger(attempt.turn, "assistant stream turn"),
    step: positiveInteger(attempt.step, "assistant stream step"),
    nextIndex: nonNegativeInteger(attempt.nextIndex, "assistant stream nextIndex"),
    stream: jsonArray(attempt.stream, "assistant stream baseline stream"),
  };
  const expanded = expandV013AssistantStream(parsed.stream);
  if (expanded.length !== parsed.nextIndex) {
    throw invalid("assistant stream baseline nextIndex");
  }
  return { revision, activeAttempt: parsed };
}

export function parseV013AssistantFrame(value: unknown): DeepSeekV013AssistantFrame {
  if (!isRecord(value) || typeof value.type !== "string") throw invalid("assistant stream frame");
  const attemptId = identifier(value.attemptId, "assistant stream attemptId");
  const revision = positiveInteger(value.revision, "assistant stream revision");
  switch (value.type) {
    case "start":
      if (!onlyKeys(value, ["type", "attemptId", "revision", "startedAfterSeq", "turn", "step"])) {
        throw invalid("assistant stream start frame");
      }
      return {
        type: "start",
        attemptId,
        revision,
        startedAfterSeq: cursor(value.startedAfterSeq, "assistant stream startedAfterSeq"),
        turn: positiveInteger(value.turn, "assistant stream turn"),
        step: positiveInteger(value.step, "assistant stream step"),
      };
    case "chunk":
      if (!onlyKeys(value, ["type", "attemptId", "revision", "index", "time", "chunk"])) {
        throw invalid("assistant stream chunk frame");
      }
      if (!isRecord(value.chunk)) throw invalid("assistant stream chunk");
      assertJsonValue(value.chunk, "assistant stream chunk");
      validateV013Chunk(value.chunk);
      return {
        type: "chunk",
        attemptId,
        revision,
        index: nonNegativeInteger(value.index, "assistant stream chunk index"),
        time: safeInteger(value.time, "assistant stream chunk time"),
        chunk: value.chunk as Readonly<Record<string, ModernJournalJson>>,
      };
    case "end": {
      if (!onlyKeys(value, ["type", "attemptId", "revision", "index", "outcome"])) {
        throw invalid("assistant stream end frame");
      }
      const outcome = value.outcome;
      if (!isRecord(outcome) || typeof outcome.kind !== "string") {
        throw invalid("assistant stream outcome");
      }
      if (outcome.kind === "abandoned") {
        if (!onlyKeys(outcome, ["kind"])) throw invalid("assistant stream abandoned outcome");
        return {
          type: "end",
          attemptId,
          revision,
          index: nonNegativeInteger(value.index, "assistant stream end index"),
          outcome: { kind: "abandoned" },
        };
      }
      if (
        outcome.kind !== "committed" ||
        !onlyKeys(outcome, ["kind", "eventType", "seq"]) ||
        (outcome.eventType !== "assistant/message" && outcome.eventType !== "assistant/attempt")
      ) {
        throw invalid("assistant stream committed outcome");
      }
      return {
        type: "end",
        attemptId,
        revision,
        index: nonNegativeInteger(value.index, "assistant stream end index"),
        outcome: {
          kind: "committed",
          eventType: outcome.eventType,
          seq: nonNegativeInteger(outcome.seq, "assistant stream settlement seq"),
        },
      };
    }
    default:
      throw invalid("assistant stream frame");
  }
}

export function expandV013AssistantStream(value: unknown): readonly DeepSeekV013TimedChunk[] {
  if (!Array.isArray(value)) throw invalid("assistant stream");
  const chunks: DeepSeekV013TimedChunk[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate.type !== "string") {
      throw invalid("assistant stream record");
    }
    if (candidate.type === "chunk") {
      if (!onlyKeys(candidate, ["type", "time", "chunk"]) || !isRecord(candidate.chunk)) {
        throw invalid("assistant stream raw chunk record");
      }
      assertJsonValue(candidate.chunk, "assistant stream raw chunk");
      validateV013Chunk(candidate.chunk);
      chunks.push({
        time: safeInteger(candidate.time, "assistant stream chunk time"),
        chunk: candidate.chunk as Readonly<Record<string, ModernJournalJson>>,
      });
      continue;
    }
    const tool = candidate.type === "tool-call-chunks";
    if (!tool && candidate.type !== "text-chunks" && candidate.type !== "reasoning-chunks") {
      throw invalid("assistant stream record kind");
    }
    const withName = tool && Object.hasOwn(candidate, "name");
    const keys = tool
      ? withName
        ? ["type", "time0", "index", "dt", "id", "name", "args"]
        : ["type", "time0", "index", "dt", "id", "args"]
      : ["type", "time0", "index", "dt", "texts"];
    if (!onlyKeys(candidate, keys)) throw invalid("assistant stream compact record");
    const members = stringArray(candidate[tool ? "args" : "texts"], "assistant stream members");
    if (members.length === 0) throw invalid("assistant stream members");
    const gaps = integerArray(candidate.dt, "assistant stream dt");
    if (gaps.length !== members.length - 1) throw invalid("assistant stream dt length");
    const index = nonNegativeInteger(candidate.index, "assistant stream block index");
    const id = tool ? identifier(candidate.id, "assistant stream tool id") : undefined;
    const name = withName ? identifier(candidate.name, "assistant stream tool name") : undefined;
    let time = safeInteger(candidate.time0, "assistant stream first time");
    for (const [memberIndex, member] of members.entries()) {
      if (memberIndex > 0)
        time = safeInteger(time + (gaps[memberIndex - 1] as number), "assistant stream time");
      const chunk = tool
        ? {
            type: "tool-call-delta" as const,
            index,
            id: id as string,
            ...(withName ? { name: name as string } : {}),
            argumentsDelta: member,
          }
        : {
            type: candidate.type === "text-chunks" ? "text-delta" : "reasoning-delta",
            index,
            text: member,
          };
      chunks.push({ time, chunk });
    }
  }
  return chunks;
}

export function v013InheritedEventCount(
  isSeeded: boolean,
  events: readonly ModernJournalEvent[],
): number | undefined {
  let inherited: number | undefined;
  for (const event of events) {
    if (
      event.type === "session/end-seed" &&
      isRecord(event.data) &&
      event.data.inherited === true
    ) {
      inherited = event.seq;
    }
  }
  if (isSeeded !== (inherited !== undefined)) throw invalid("Session inherited marker");
  return inherited;
}

function jsonArray(value: unknown, label: string): readonly ModernJournalJson[] {
  if (!Array.isArray(value)) throw invalid(label);
  assertJsonValue(value, label);
  return value as readonly ModernJournalJson[];
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((member) => typeof member !== "string")) {
    throw invalid(label);
  }
  return value;
}

function integerArray(value: unknown, label: string): readonly number[] {
  if (!Array.isArray(value) || value.some((member) => !Number.isSafeInteger(member))) {
    throw invalid(label);
  }
  return value as readonly number[];
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw invalid(label);
  return value;
}

function cursor(value: unknown, label: string): number {
  return value === -1 ? value : nonNegativeInteger(value, label);
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = safeInteger(value, label);
  if (parsed <= 0) throw invalid(label);
  return parsed;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const parsed = safeInteger(value, label);
  if (parsed < 0 || Object.is(parsed, -0)) throw invalid(label);
  return parsed;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
  );
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw invalid(label);
  return value as number;
}

function onlyKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key))
  );
}

function assertJsonValue(value: unknown, label: string): void {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const item = pending.pop() as { readonly value: unknown; readonly depth: number };
    const current = item.value;
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean" ||
      (typeof current === "number" && Number.isFinite(current))
    ) {
      continue;
    }
    if (typeof current !== "object" || item.depth >= 100 || seen.has(current)) {
      throw invalid(label);
    }
    const prototype = Object.getPrototypeOf(current);
    if (
      Array.isArray(current)
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    ) {
      throw invalid(label);
    }
    seen.add(current);
    if (Array.isArray(current)) {
      const keys = Reflect.ownKeys(current);
      if (
        keys.length !== current.length + 1 ||
        !keys.every(
          (key) =>
            key === "length" ||
            (typeof key === "string" &&
              /^(?:0|[1-9]\d*)$/u.test(key) &&
              Number(key) < current.length),
        )
      ) {
        throw invalid(label);
      }
      for (let index = 0; index < current.length; index += 1) {
        if (!Object.hasOwn(current, index)) throw invalid(label);
        pending.push({ value: current[index], depth: item.depth + 1 });
      }
      continue;
    }
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key !== "string") throw invalid(label);
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
        throw invalid(label);
      }
      pending.push({ value: descriptor.value, depth: item.depth + 1 });
    }
  }
}

function validateV013Chunk(value: Readonly<Record<string, unknown>>): void {
  switch (value.type) {
    case "block-start":
      if (
        !onlyKeys(value, ["type", "index", "blockType"]) ||
        typeof value.blockType !== "string" ||
        value.blockType.length === 0
      ) {
        throw invalid("assistant stream block-start chunk");
      }
      nonNegativeInteger(value.index, "assistant stream block-start index");
      return;
    case "text-delta":
    case "reasoning-delta":
      if (!onlyKeys(value, ["type", "index", "text"]) || typeof value.text !== "string") {
        throw invalid("assistant stream text chunk");
      }
      nonNegativeInteger(value.index, "assistant stream text index");
      return;
    case "tool-call-delta":
      if (
        !onlyKeys(value, ["type", "index", "id", "argumentsDelta"], ["name"]) ||
        typeof value.id !== "string" ||
        value.id.length === 0 ||
        typeof value.argumentsDelta !== "string" ||
        (value.name !== undefined && (typeof value.name !== "string" || value.name.length === 0))
      ) {
        throw invalid("assistant stream tool-call chunk");
      }
      nonNegativeInteger(value.index, "assistant stream tool-call index");
      return;
    case "block-end":
      if (!onlyKeys(value, ["type", "index", "block"]) || !isRecord(value.block)) {
        throw invalid("assistant stream block-end chunk");
      }
      nonNegativeInteger(value.index, "assistant stream block-end index");
      validateV013ContentBlock(value.block);
      return;
    case "usage":
      if (!onlyKeys(value, ["type", "usage"]) || !isRecord(value.usage)) {
        throw invalid("assistant stream usage chunk");
      }
      return;
    case "finish":
      if (!onlyKeys(value, ["type", "reason"], ["replayState"]) || !isRecord(value.reason)) {
        throw invalid("assistant stream finish chunk");
      }
      return;
    default:
      throw invalid("assistant stream chunk kind");
  }
}

function validateV013ContentBlock(value: Readonly<Record<string, unknown>>): void {
  switch (value.type) {
    case "text":
    case "reasoning":
      if (!onlyKeys(value, ["type", "text"]) || typeof value.text !== "string") {
        throw invalid("assistant stream content block");
      }
      return;
    case "image":
    case "file":
      if (!onlyKeys(value, ["type", "attachment"]) || !isRecord(value.attachment)) {
        throw invalid("assistant stream attachment block");
      }
      return;
    case "tool-call":
      if (
        !onlyKeys(value, ["type", "id", "name", "arguments"]) ||
        typeof value.id !== "string" ||
        value.id.length === 0 ||
        typeof value.name !== "string" ||
        value.name.length === 0 ||
        typeof value.arguments !== "string"
      ) {
        throw invalid("assistant stream tool-call block");
      }
      return;
    default:
      throw invalid("assistant stream content block kind");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(area: string): DeepSeekV013ProtocolError {
  return new DeepSeekV013ProtocolError(`DeepSeek Harness v0.1.3 ${area} is malformed`);
}
