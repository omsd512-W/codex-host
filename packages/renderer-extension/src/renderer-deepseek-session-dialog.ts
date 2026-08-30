import type { DeepSeekNativeSessionCandidate, HostThreadId } from "@codexhost/shared-contracts";

import { openRendererThread } from "./renderer-fork-control.js";
import { rendererHarnessMessages } from "./renderer-harness-localization.js";
import type { RendererModelClient } from "./renderer-model-client.js";
import type { RendererSettingsLocale } from "./settings/localization.js";
import type { ComposerAgentPhase, RendererAgent } from "./agent-selection-state.js";

const CONTROL_ATTRIBUTE = "data-codexhost-deepseek-session-control";

export interface RendererDeepSeekSessionContext {
  composer: Element;
  composerId: string;
  target: readonly unknown[];
  hostId: string | null;
  cwd: string | null;
  client: RendererModelClient | null;
  clearPrewarm: (() => Promise<void>) | null;
  ready: boolean;
}

type ReadyRendererDeepSeekSessionContext = RendererDeepSeekSessionContext & {
  hostId: string;
  cwd: string;
  client: RendererModelClient;
  clearPrewarm: () => Promise<void>;
  ready: true;
};

export type RendererDeepSeekSessionDialogPhase =
  "idle" | "loading" | "empty" | "error" | "ready" | "linking" | "opening";

export interface RendererDeepSeekSessionDialogView {
  visible: boolean;
  disabled: boolean;
  open: boolean;
  phase: RendererDeepSeekSessionDialogPhase;
  candidates: readonly DeepSeekNativeSessionCandidate[];
  selectedNativeSessionId: string | null;
  error: string | null;
  locale: RendererSettingsLocale;
}

export interface RendererDeepSeekSessionDialogController {
  view(): RendererDeepSeekSessionDialogView;
  sync(locale: RendererSettingsLocale): void;
  open(): Promise<void>;
  retry(): Promise<void>;
  select(nativeSessionId: string): void;
  confirm(): Promise<void>;
  cancel(): boolean;
  dispose(): void;
}

export interface RendererDeepSeekSessionDialogControl {
  root: HTMLElement;
  trigger: HTMLButtonElement;
  dialog: HTMLDialogElement;
  sync(locale: RendererSettingsLocale): void;
  dispose(): void;
}

function sameTarget(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameContext(
  left: ReadyRendererDeepSeekSessionContext,
  right: RendererDeepSeekSessionContext | null,
): right is ReadyRendererDeepSeekSessionContext {
  return (
    right !== null &&
    right.ready === true &&
    typeof right.hostId === "string" &&
    typeof right.cwd === "string" &&
    right.client !== null &&
    left.composer === right.composer &&
    left.composerId === right.composerId &&
    left.hostId === right.hostId &&
    left.cwd === right.cwd &&
    left.client === right.client &&
    left.clearPrewarm === right.clearPrewarm &&
    sameTarget(left.target, right.target)
  );
}

function readyContext(
  context: RendererDeepSeekSessionContext | null,
): context is ReadyRendererDeepSeekSessionContext {
  return (
    context?.ready === true &&
    typeof context.hostId === "string" &&
    typeof context.cwd === "string" &&
    context.client !== null &&
    typeof context.clearPrewarm === "function"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function shouldShowDeepSeekSessionEntry(input: {
  agent: RendererAgent;
  phase: ComposerAgentPhase;
  target: readonly unknown[] | null;
}): boolean {
  return (
    input.agent === "deepseek-harness" && input.phase === "draft" && input.target?.[0] === "default"
  );
}

export function nextDeepSeekSessionSelection(
  candidates: readonly DeepSeekNativeSessionCandidate[],
  selectedNativeSessionId: string | null,
  key: string,
): string | null {
  const enabled = candidates.filter((candidate) => !candidate.running);
  if (enabled.length === 0) return null;
  if (key === "Home") return enabled[0]?.nativeSessionId ?? null;
  if (key === "End") return enabled.at(-1)?.nativeSessionId ?? null;
  const direction =
    key === "ArrowDown" || key === "ArrowRight"
      ? 1
      : key === "ArrowUp" || key === "ArrowLeft"
        ? -1
        : 0;
  if (direction === 0) return selectedNativeSessionId;
  const selectedIndex = enabled.findIndex(
    (candidate) => candidate.nativeSessionId === selectedNativeSessionId,
  );
  const start = selectedIndex < 0 ? (direction > 0 ? -1 : 0) : selectedIndex;
  return enabled[(start + direction + enabled.length) % enabled.length]?.nativeSessionId ?? null;
}

export function createRendererDeepSeekSessionDialogController(options: {
  getContext(): RendererDeepSeekSessionContext | null;
  render(view: RendererDeepSeekSessionDialogView): void;
  openThread?(
    threadId: HostThreadId,
    input: { hostId: string; signal: AbortSignal },
  ): Promise<void>;
}): RendererDeepSeekSessionDialogController {
  let disposed = false;
  let generation = 0;
  let captured: ReadyRendererDeepSeekSessionContext | null = null;
  let navigation: AbortController | null = null;
  let state: RendererDeepSeekSessionDialogView = {
    visible: false,
    disabled: true,
    open: false,
    phase: "idle",
    candidates: [],
    selectedNativeSessionId: null,
    error: null,
    locale: "en",
  };
  const publish = (next: Partial<RendererDeepSeekSessionDialogView> = {}): void => {
    state = { ...state, ...next };
    options.render(state);
  };
  const invalidate = (): void => {
    generation += 1;
    navigation?.abort();
    navigation = null;
    captured = null;
  };
  const isCurrent = (
    requestGeneration: number,
    context: ReadyRendererDeepSeekSessionContext,
  ): boolean =>
    !disposed && generation === requestGeneration && sameContext(context, options.getContext());

  const list = async (): Promise<void> => {
    const context = options.getContext();
    if (disposed || !readyContext(context)) return;
    invalidate();
    captured = context;
    const requestGeneration = generation;
    publish({
      open: true,
      phase: "loading",
      candidates: [],
      selectedNativeSessionId: null,
      error: null,
    });
    try {
      const result = await context.client.listDeepSeekNativeSessionCandidates({
        cwd: context.cwd,
      });
      if (!isCurrent(requestGeneration, context)) return;
      publish({
        phase: result.candidates.length === 0 ? "empty" : "ready",
        candidates: result.candidates,
      });
    } catch (error) {
      if (!isCurrent(requestGeneration, context)) return;
      publish({ phase: "error", error: errorMessage(error) });
    }
  };

  const controller: RendererDeepSeekSessionDialogController = {
    view: () => state,
    sync(locale) {
      if (disposed) return;
      const context = options.getContext();
      if (captured && !sameContext(captured, context)) {
        invalidate();
        publish({
          open: false,
          phase: "idle",
          candidates: [],
          selectedNativeSessionId: null,
          error: null,
        });
      }
      publish({
        visible: context !== null,
        disabled: !readyContext(context),
        locale,
      });
    },
    open: list,
    retry: list,
    select(nativeSessionId) {
      if (state.phase !== "ready") return;
      const candidate = state.candidates.find((entry) => entry.nativeSessionId === nativeSessionId);
      if (!candidate || candidate.running) return;
      publish({ selectedNativeSessionId: candidate.nativeSessionId });
    },
    async confirm() {
      const context = captured;
      const selectedNativeSessionId = state.selectedNativeSessionId;
      const candidate = state.candidates.find(
        (entry) => entry.nativeSessionId === selectedNativeSessionId,
      );
      if (
        disposed ||
        state.phase !== "ready" ||
        !context ||
        !selectedNativeSessionId ||
        !candidate ||
        candidate.running ||
        !sameContext(context, options.getContext())
      ) {
        return;
      }
      const requestGeneration = generation;
      publish({ phase: "linking", error: null });
      try {
        await context.clearPrewarm();
        if (!isCurrent(requestGeneration, context)) return;
        const result = await context.client.linkDeepSeekNativeSession({
          cwd: context.cwd,
          nativeSessionId: selectedNativeSessionId,
        });
        if (
          !isCurrent(requestGeneration, context) ||
          state.selectedNativeSessionId !== selectedNativeSessionId
        ) {
          return;
        }
        publish({ phase: "opening" });
        navigation = new AbortController();
        const openThread =
          options.openThread ?? ((threadId, input) => openRendererThread(threadId, input));
        await openThread(result.threadId, {
          hostId: context.hostId,
          signal: navigation.signal,
        });
        if (!isCurrent(requestGeneration, context)) return;
        invalidate();
        publish({
          open: false,
          phase: "idle",
          candidates: [],
          selectedNativeSessionId: null,
        });
      } catch (error) {
        if (!isCurrent(requestGeneration, context)) return;
        navigation = null;
        publish({ phase: "error", error: errorMessage(error) });
      }
    },
    cancel() {
      if (state.phase === "linking" || state.phase === "opening") return false;
      invalidate();
      publish({
        open: false,
        phase: "idle",
        candidates: [],
        selectedNativeSessionId: null,
        error: null,
      });
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      invalidate();
    },
  };
  options.render(state);
  return controller;
}

function setButtonStyle(button: HTMLButtonElement): void {
  button.style.minHeight = "28px";
  button.style.padding = "4px 10px";
  button.style.border = "1px solid rgba(127, 127, 127, 0.25)";
  button.style.borderRadius = "8px";
  button.style.background = "transparent";
  button.style.color = "inherit";
  button.style.font = "500 12px/18px system-ui, sans-serif";
}

export function mountRendererDeepSeekSessionDialog(
  composerId: string,
  parent: Element,
  insertBefore: Element | null,
  getContext: () => RendererDeepSeekSessionContext | null,
): RendererDeepSeekSessionDialogControl {
  const ownerDocument = parent.ownerDocument;
  const root = ownerDocument.createElement("span");
  root.setAttribute(CONTROL_ATTRIBUTE, composerId);
  root.style.display = "inline-flex";

  const trigger = ownerDocument.createElement("button");
  trigger.type = "button";
  trigger.setAttribute("aria-haspopup", "dialog");
  setButtonStyle(trigger);
  root.append(trigger);

  const dialog = ownerDocument.createElement("dialog");
  const dialogId = `${composerId}-deepseek-session-dialog`;
  const titleId = `${composerId}-deepseek-session-title`;
  const descriptionId = `${composerId}-deepseek-session-description`;
  dialog.id = dialogId;
  trigger.setAttribute("aria-controls", dialogId);
  dialog.setAttribute("aria-labelledby", titleId);
  dialog.setAttribute("aria-describedby", descriptionId);
  dialog.setAttribute("aria-modal", "true");
  dialog.style.width = "min(560px, calc(100vw - 32px))";
  dialog.style.maxHeight = "min(640px, calc(100vh - 32px))";
  dialog.style.padding = "20px";
  dialog.style.border = "1px solid rgba(127, 127, 127, 0.28)";
  dialog.style.borderRadius = "14px";
  dialog.style.background = "Canvas";
  dialog.style.color = "CanvasText";
  dialog.style.boxShadow = "0 20px 60px rgba(0, 0, 0, 0.3)";

  const title = ownerDocument.createElement("h2");
  title.id = titleId;
  title.style.margin = "0";
  title.style.font = "600 17px/24px system-ui, sans-serif";
  const description = ownerDocument.createElement("p");
  description.id = descriptionId;
  description.style.margin = "6px 0 14px";
  description.style.color = "rgba(127, 127, 127, 0.95)";
  description.style.font = "400 12px/18px system-ui, sans-serif";
  const content = ownerDocument.createElement("div");
  content.style.maxHeight = "min(430px, calc(100vh - 190px))";
  content.style.overflowY = "auto";
  const footer = ownerDocument.createElement("div");
  footer.style.display = "flex";
  footer.style.justifyContent = "flex-end";
  footer.style.gap = "8px";
  footer.style.marginTop = "16px";
  const cancel = ownerDocument.createElement("button");
  cancel.type = "button";
  setButtonStyle(cancel);
  const confirm = ownerDocument.createElement("button");
  confirm.type = "button";
  setButtonStyle(confirm);
  footer.append(cancel, confirm);
  dialog.append(title, description, content, footer);
  ownerDocument.body.append(dialog);

  if (insertBefore?.parentElement === parent) parent.insertBefore(root, insertBefore);
  else parent.append(root);

  const render = (view: RendererDeepSeekSessionDialogView): void => {
    let focusTarget: HTMLElement | null = null;
    const messages = rendererHarnessMessages(view.locale);
    root.hidden = !view.visible;
    trigger.disabled = view.disabled;
    trigger.textContent = messages.openExistingSession;
    trigger.title = view.disabled
      ? messages.existingSessionUnavailable
      : messages.openExistingSession;
    trigger.setAttribute("aria-label", messages.openExistingSession);
    title.textContent = messages.existingSessionTitle;
    description.textContent = messages.existingSessionDescription;
    cancel.textContent = messages.cancel;
    confirm.textContent = messages.open;
    dialog.setAttribute(
      "aria-busy",
      String(view.phase === "loading" || view.phase === "linking" || view.phase === "opening"),
    );
    cancel.disabled = view.phase === "linking" || view.phase === "opening";
    confirm.disabled = view.phase !== "ready" || view.selectedNativeSessionId === null;
    content.replaceChildren();

    if (view.phase === "ready") {
      const list = ownerDocument.createElement("div");
      list.setAttribute("role", "radiogroup");
      list.setAttribute("aria-label", messages.existingSessionTitle);
      list.style.display = "grid";
      list.style.gap = "8px";
      const rows = new Map<string, HTMLButtonElement>();
      const firstEnabled = view.candidates.find((candidate) => !candidate.running);
      for (const candidate of view.candidates) {
        const row = ownerDocument.createElement("button");
        row.type = "button";
        row.setAttribute("role", "radio");
        row.setAttribute(
          "aria-checked",
          String(candidate.nativeSessionId === view.selectedNativeSessionId),
        );
        row.setAttribute("aria-disabled", String(candidate.running));
        row.disabled = candidate.running;
        row.tabIndex =
          candidate.nativeSessionId === view.selectedNativeSessionId ||
          (view.selectedNativeSessionId === null && candidate === firstEnabled)
            ? 0
            : -1;
        row.style.display = "grid";
        row.style.gap = "4px";
        row.style.padding = "10px";
        row.style.border =
          candidate.nativeSessionId === view.selectedNativeSessionId
            ? "1px solid Highlight"
            : "1px solid rgba(127, 127, 127, 0.24)";
        row.style.borderRadius = "10px";
        row.style.background = "transparent";
        row.style.color = "inherit";
        row.style.textAlign = "left";
        row.style.opacity = candidate.running ? "0.6" : "1";

        const heading = ownerDocument.createElement("strong");
        heading.textContent = candidate.title ?? messages.untitledSession;
        const identity = ownerDocument.createElement("span");
        identity.textContent = `${messages.sessionId}: ${candidate.nativeSessionId}`;
        const metadata = ownerDocument.createElement("span");
        const updatedAt = new Intl.DateTimeFormat(view.locale === "zh-CN" ? "zh-CN" : "en", {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(candidate.updatedAt));
        metadata.textContent = `${messages.updatedAt}: ${updatedAt} · ${messages.workingDirectory}: ${candidate.cwd}`;
        const status = ownerDocument.createElement("span");
        status.textContent = [
          candidate.running ? messages.runningSession : null,
          candidate.blank ? messages.emptySession : null,
        ]
          .filter((value): value is string => value !== null)
          .join(" · ");
        for (const secondary of [identity, metadata, status]) {
          secondary.style.color = "rgba(127, 127, 127, 0.95)";
          secondary.style.font = "400 11px/16px system-ui, sans-serif";
        }
        row.append(heading, identity, metadata);
        if (status.textContent) row.append(status);
        row.addEventListener("click", () => controller.select(candidate.nativeSessionId));
        rows.set(candidate.nativeSessionId, row);
        list.append(row);
      }
      list.addEventListener("keydown", (event) => {
        const next = nextDeepSeekSessionSelection(
          view.candidates,
          controller.view().selectedNativeSessionId,
          event.key,
        );
        if (!next || next === controller.view().selectedNativeSessionId) return;
        event.preventDefault();
        controller.select(next);
        queueMicrotask(() => rows.get(next)?.focus());
      });
      content.append(list);
      focusTarget =
        rows.get(view.selectedNativeSessionId ?? firstEnabled?.nativeSessionId ?? "") ?? null;
    } else {
      const status = ownerDocument.createElement("p");
      status.tabIndex = -1;
      status.setAttribute("aria-live", view.phase === "error" ? "assertive" : "polite");
      status.style.margin = "8px 0";
      status.style.font = "400 13px/20px system-ui, sans-serif";
      if (view.phase === "loading") status.textContent = messages.loadingExistingSessions;
      else if (view.phase === "empty") status.textContent = messages.noExistingSessions;
      else if (view.phase === "linking") status.textContent = messages.linkingExistingSession;
      else if (view.phase === "opening") status.textContent = messages.openingExistingSession;
      else if (view.phase === "error") {
        status.setAttribute("role", "alert");
        status.textContent = `${messages.existingSessionsFailed}${view.error ? ` ${view.error}` : ""}`;
      }
      if (view.phase !== "error") status.setAttribute("role", "status");
      content.append(status);
      focusTarget = status;
      if (view.phase === "error") {
        const retry = ownerDocument.createElement("button");
        retry.type = "button";
        retry.textContent = messages.retry;
        setButtonStyle(retry);
        retry.addEventListener("click", () => void controller.retry());
        content.append(retry);
      }
    }

    if (view.open && !dialog.open) {
      dialog.showModal();
    } else if (!view.open && dialog.open) {
      dialog.close();
      if (view.visible && trigger.isConnected) trigger.focus();
    }
    if (view.open && focusTarget) {
      queueMicrotask(() => {
        if (focusTarget?.isConnected) focusTarget.focus();
      });
    }
  };

  const controller = createRendererDeepSeekSessionDialogController({ getContext, render });
  trigger.addEventListener("click", () => void controller.open());
  cancel.addEventListener("click", () => controller.cancel());
  confirm.addEventListener("click", () => void controller.confirm());
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    controller.cancel();
  });

  return {
    root,
    trigger,
    dialog,
    sync: (locale) => controller.sync(locale),
    dispose() {
      controller.dispose();
      if (dialog.open) dialog.close();
      dialog.remove();
      root.remove();
    },
  };
}
