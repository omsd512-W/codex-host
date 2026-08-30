import {
  hostThreadIdSchema,
  type DeepSeekNativeSessionCandidate,
} from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createRendererDeepSeekSessionDialogController,
  mountRendererDeepSeekSessionDialog,
  nextDeepSeekSessionSelection,
  shouldShowDeepSeekSessionEntry,
  type RendererDeepSeekSessionContext,
  type RendererDeepSeekSessionDialogView,
} from "../src/renderer-deepseek-session-dialog.js";
import { rendererHarnessMessages } from "../src/renderer-harness-localization.js";
import type { RendererModelClient } from "../src/renderer-model-client.js";

const available: DeepSeekNativeSessionCandidate = {
  nativeSessionId: "native-available",
  title: "Existing session",
  updatedAt: 1_700_000_000_000,
  cwd: "C:\\work",
  running: false,
  blank: false,
};
const running: DeepSeekNativeSessionCandidate = {
  nativeSessionId: "native-running",
  title: null,
  updatedAt: 1_700_000_000_001,
  cwd: "C:\\work",
  running: true,
  blank: true,
};

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, Array<(event: Event) => void>>();
  readonly style = {} as CSSStyleDeclaration;
  disabled = false;
  hidden = false;
  id = "";
  open = false;
  parentElement: FakeElement | null = null;
  tabIndex = 0;
  textContent = "";
  title = "";
  type = "";
  #connected = false;

  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDocument,
  ) {}

  get isConnected(): boolean {
    return this.#connected || this.parentElement?.isConnected === true;
  }

  get nextElementSibling(): FakeElement | null {
    if (!this.parentElement) return null;
    const index = this.parentElement.children.indexOf(this);
    return this.parentElement.children[index + 1] ?? null;
  }

  connect(): void {
    this.#connected = true;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  append(...elements: FakeElement[]): void {
    for (const element of elements) {
      element.remove();
      element.parentElement = this;
      this.children.push(element);
    }
  }

  insertBefore(element: FakeElement, reference: FakeElement): void {
    element.remove();
    const index = this.children.indexOf(reference);
    element.parentElement = this;
    this.children.splice(index < 0 ? this.children.length : index, 0, element);
  }

  replaceChildren(...elements: FakeElement[]): void {
    for (const child of this.children) child.parentElement = null;
    this.children.splice(0);
    this.append(...elements);
  }

  remove(): void {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  click(): void {
    if (this.disabled) return;
    const event = {
      target: this,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as Event;
    for (const listener of this.listeners.get("click") ?? []) listener(event);
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }
}

class FakeDialog extends FakeElement {
  showModal(): void {
    this.open = true;
  }

  close(): void {
    this.open = false;
  }
}

class FakeDocument {
  activeElement: FakeElement | null = null;
  readonly body: FakeElement;

  constructor() {
    this.body = new FakeElement("body", this);
    this.body.connect();
  }

  createElement(tagName: string): FakeElement {
    return tagName === "dialog" ? new FakeDialog(tagName, this) : new FakeElement(tagName, this);
  }
}

function descendants(root: FakeElement): FakeElement[] {
  return root.children.flatMap((child) => [child, ...descendants(child)]);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const listDeepSeekNativeSessionCandidates = vi.fn(async () => ({
    candidates: [available, running],
  }));
  const linkDeepSeekNativeSession = vi.fn(async () => ({
    threadId: hostThreadIdSchema.parse("linked-thread"),
  }));
  const client = {
    listDeepSeekNativeSessionCandidates,
    linkDeepSeekNativeSession,
  } as unknown as RendererModelClient;
  const clearPrewarm = vi.fn(async () => undefined);
  let context: RendererDeepSeekSessionContext | null = {
    composer: {} as Element,
    composerId: "composer-1",
    target: ["default", "draft-1"],
    hostId: "remote-1",
    cwd: "C:\\work",
    client,
    clearPrewarm,
    ready: true,
  };
  const views: RendererDeepSeekSessionDialogView[] = [];
  const openThread = vi.fn<
    (
      _threadId: ReturnType<typeof hostThreadIdSchema.parse>,
      _input: {
        hostId: string;
        signal: AbortSignal;
      },
    ) => Promise<void>
  >(async () => undefined);
  const controller = createRendererDeepSeekSessionDialogController({
    getContext: () => context,
    render: (view) => views.push({ ...view }),
    openThread,
  });
  return {
    client,
    clearPrewarm,
    controller,
    latest() {
      const latest = views.at(-1);
      if (!latest) throw new Error("Dialog fixture did not render");
      return latest;
    },
    listDeepSeekNativeSessionCandidates,
    linkDeepSeekNativeSession,
    openThread,
    setContext(next: RendererDeepSeekSessionContext | null) {
      context = next;
    },
  };
}

describe("Renderer DeepSeek existing Session dialog", () => {
  it("mounts an accessible native Dialog and restores trigger focus after cancellation", async () => {
    const ownerDocument = new FakeDocument();
    const parent = new FakeElement("div", ownerDocument);
    parent.connect();
    const test = fixture();
    const mountedContext: RendererDeepSeekSessionContext = {
      composer: parent as unknown as Element,
      composerId: "composer-mounted",
      target: ["default", "draft-mounted"],
      hostId: "remote-1",
      cwd: "C:\\work",
      client: test.client,
      clearPrewarm: test.clearPrewarm,
      ready: true,
    };
    const control = mountRendererDeepSeekSessionDialog(
      "composer-mounted",
      parent as unknown as Element,
      null,
      () => mountedContext,
    );
    const trigger = control.trigger as unknown as FakeElement;
    const dialog = control.dialog as unknown as FakeDialog;

    control.sync("en");
    expect(trigger.disabled).toBe(false);
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.getAttribute("aria-controls")).toBe(dialog.id);
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("composer-mounted-deepseek-session-title");
    expect(dialog.getAttribute("aria-describedby")).toBe(
      "composer-mounted-deepseek-session-description",
    );

    trigger.click();
    await vi.waitFor(() => {
      expect(test.listDeepSeekNativeSessionCandidates).toHaveBeenCalled();
      expect(dialog.getAttribute("aria-busy")).toBe("false");
    });
    expect(dialog.open).toBe(true);
    const dialogButtons = descendants(dialog).filter(({ tagName }) => tagName === "button");
    const rows = dialogButtons.filter((button) => button.getAttribute("role") === "radio");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ disabled: false, tabIndex: 0 });
    expect(rows[1]).toMatchObject({ disabled: true, tabIndex: -1 });
    expect(rows[1]?.getAttribute("aria-disabled")).toBe("true");
    const confirm = dialogButtons.find(({ textContent }) => textContent === "Open");
    const cancel = dialogButtons.find(({ textContent }) => textContent === "Cancel");
    expect(confirm?.disabled).toBe(true);
    if (!cancel) throw new Error("Mounted Dialog omitted its cancel action");

    cancel.click();

    expect(dialog.open).toBe(false);
    expect(ownerDocument.activeElement).toBe(trigger);
    control.dispose();
  });

  it("shows only for an unlocked DeepSeek new-task target", () => {
    expect(
      shouldShowDeepSeekSessionEntry({
        agent: "deepseek-harness",
        phase: "draft",
        target: ["default", "draft-1"],
      }),
    ).toBe(true);
    for (const input of [
      { agent: "codex" as const, phase: "draft" as const, target: ["default"] },
      {
        agent: "deepseek-harness" as const,
        phase: "locked" as const,
        target: ["default"],
      },
      {
        agent: "deepseek-harness" as const,
        phase: "draft" as const,
        target: ["conversation", "thread-1"],
      },
    ]) {
      expect(shouldShowDeepSeekSessionEntry(input)).toBe(false);
    }
  });

  it("keeps the entry visible but disabled until Host and cwd are ready", () => {
    const test = fixture();
    const disabled = {
      composer: {} as Element,
      composerId: "composer-1",
      target: ["default", "draft-1"],
      hostId: null,
      cwd: null,
      client: null,
      clearPrewarm: null,
      ready: false,
    } satisfies RendererDeepSeekSessionContext;
    test.setContext(disabled);
    test.controller.sync("zh-CN");
    expect(test.latest()).toMatchObject({ visible: true, disabled: true, locale: "zh-CN" });
    test.setContext(null);
    test.controller.sync("en");
    expect(test.latest()).toMatchObject({ visible: false, disabled: true });
  });

  it("renders loading, list, running-disabled selection and opens the linked Host Thread", async () => {
    const test = fixture();
    const pending = deferred<{ candidates: DeepSeekNativeSessionCandidate[] }>();
    test.listDeepSeekNativeSessionCandidates.mockReturnValueOnce(pending.promise);
    test.controller.sync("en");

    const opening = test.controller.open();
    expect(test.latest()).toMatchObject({ open: true, phase: "loading" });
    pending.resolve({ candidates: [available, running] });
    await opening;
    expect(test.latest()).toMatchObject({ phase: "ready", selectedNativeSessionId: null });

    test.controller.select(running.nativeSessionId);
    expect(test.latest().selectedNativeSessionId).toBeNull();
    test.controller.select(available.nativeSessionId);
    await test.controller.confirm();

    expect(test.listDeepSeekNativeSessionCandidates).toHaveBeenCalledWith({ cwd: "C:\\work" });
    expect(test.linkDeepSeekNativeSession).toHaveBeenCalledWith({
      cwd: "C:\\work",
      nativeSessionId: "native-available",
    });
    expect(test.clearPrewarm).toHaveBeenCalledOnce();
    expect(test.clearPrewarm.mock.invocationCallOrder[0]).toBeLessThan(
      test.linkDeepSeekNativeSession.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(test.openThread).toHaveBeenCalledWith("linked-thread", {
      hostId: "remote-1",
      signal: expect.any(AbortSignal),
    });
    expect(test.latest()).toMatchObject({ open: false, phase: "idle" });
  });

  it("renders empty and error states and ignores an older retry response", async () => {
    const test = fixture();
    test.listDeepSeekNativeSessionCandidates.mockResolvedValueOnce({ candidates: [] });
    await test.controller.open();
    expect(test.latest().phase).toBe("empty");

    const old = deferred<{ candidates: DeepSeekNativeSessionCandidate[] }>();
    const current = deferred<{ candidates: DeepSeekNativeSessionCandidate[] }>();
    test.listDeepSeekNativeSessionCandidates
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    const oldRequest = test.controller.retry();
    const currentRequest = test.controller.retry();
    current.resolve({ candidates: [available] });
    await currentRequest;
    old.reject(new Error("stale transport failure"));
    await oldRequest;
    expect(test.latest()).toMatchObject({ phase: "ready", candidates: [available] });

    test.listDeepSeekNativeSessionCandidates.mockRejectedValueOnce(new Error("DSH offline"));
    await test.controller.retry();
    expect(test.latest()).toMatchObject({ phase: "error", error: "DSH offline" });
  });

  it("does not link when draft prewarm cleanup fails", async () => {
    const test = fixture();
    await test.controller.open();
    test.controller.select(available.nativeSessionId);
    test.clearPrewarm.mockRejectedValueOnce(new Error("prewarm cleanup failed"));

    await test.controller.confirm();

    expect(test.linkDeepSeekNativeSession).not.toHaveBeenCalled();
    expect(test.latest()).toMatchObject({
      phase: "error",
      error: "prewarm cleanup failed",
    });
  });

  it("cancels discovery but keeps close disabled while a link is committing", async () => {
    const test = fixture();
    const listing = deferred<{ candidates: DeepSeekNativeSessionCandidate[] }>();
    test.listDeepSeekNativeSessionCandidates.mockReturnValueOnce(listing.promise);
    const request = test.controller.open();
    expect(test.controller.cancel()).toBe(true);
    listing.resolve({ candidates: [available] });
    await request;
    expect(test.latest()).toMatchObject({ open: false, phase: "idle" });

    await test.controller.open();
    test.controller.select(available.nativeSessionId);
    const linking = deferred<{ threadId: ReturnType<typeof hostThreadIdSchema.parse> }>();
    test.linkDeepSeekNativeSession.mockReturnValueOnce(linking.promise);
    const confirmation = test.controller.confirm();
    expect(test.controller.cancel()).toBe(false);
    expect(test.latest()).toMatchObject({ open: true, phase: "linking" });
    linking.resolve({ threadId: hostThreadIdSchema.parse("linked-thread") });
    await confirmation;
  });

  it("never opens a Host-committed Thread after the Composer context becomes stale", async () => {
    const test = fixture();
    await test.controller.open();
    test.controller.select(available.nativeSessionId);
    const linked = deferred<{ threadId: ReturnType<typeof hostThreadIdSchema.parse> }>();
    test.linkDeepSeekNativeSession.mockReturnValueOnce(linked.promise);
    const confirmation = test.controller.confirm();
    expect(test.latest().phase).toBe("linking");

    test.setContext({
      composer: {} as Element,
      composerId: "composer-2",
      target: ["default", "draft-2"],
      hostId: "remote-1",
      cwd: "C:\\work",
      client: test.client,
      clearPrewarm: test.clearPrewarm,
      ready: true,
    });
    linked.resolve({ threadId: hostThreadIdSchema.parse("committed-thread") });
    await confirmation;
    expect(test.openThread).not.toHaveBeenCalled();
  });

  it("single-flights confirmation and aborts stale sidebar navigation", async () => {
    const test = fixture();
    await test.controller.open();
    test.controller.select(available.nativeSessionId);
    const navigation = deferred<undefined>();
    let navigationSignal: AbortSignal | undefined;
    test.openThread.mockImplementationOnce(async (_threadId, input) => {
      navigationSignal = input.signal;
      input.signal.addEventListener("abort", () => navigation.resolve(undefined), { once: true });
      return navigation.promise;
    });

    const first = test.controller.confirm();
    const duplicate = test.controller.confirm();
    await duplicate;
    expect(test.linkDeepSeekNativeSession).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(test.latest().phase).toBe("opening"));
    test.setContext(null);
    test.controller.sync("en");
    await first;
    expect(navigationSignal?.aborted).toBe(true);
    expect(test.latest()).toMatchObject({ visible: false, open: false });
  });

  it("supports Arrow/Home/End navigation while skipping running rows", () => {
    expect(nextDeepSeekSessionSelection([running, available], null, "Home")).toBe(
      available.nativeSessionId,
    );
    expect(
      nextDeepSeekSessionSelection([available, running], available.nativeSessionId, "End"),
    ).toBe(available.nativeSessionId);
    const another = { ...available, nativeSessionId: "native-another" };
    expect(
      nextDeepSeekSessionSelection(
        [available, running, another],
        available.nativeSessionId,
        "ArrowDown",
      ),
    ).toBe("native-another");
    expect(
      nextDeepSeekSessionSelection(
        [available, running, another],
        available.nativeSessionId,
        "ArrowUp",
      ),
    ).toBe("native-another");
  });

  it("localizes every stable user-facing label", () => {
    expect(rendererHarnessMessages("zh-CN")).toMatchObject({
      openExistingSession: "打开已有会话",
      retry: "重试",
      cancel: "取消",
      untitledSession: "未命名会话",
    });
    expect(rendererHarnessMessages("en")).toMatchObject({
      openExistingSession: "Open existing session",
      retry: "Retry",
    });
  });
});
