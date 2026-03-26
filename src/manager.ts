import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  OpenClawPluginServiceContext,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk/core";
import type { PluginConfig, ResolvedPluginConfig } from "./config.js";
import { finalizePluginConfig } from "./config.js";
import { JsonlWriter } from "./jsonl-writer.js";
import { resolveOpenClawRoot } from "./openclaw-root.js";
import { redactHeaders, redactValue } from "./redaction.js";

type Logger = Pick<OpenClawPluginServiceContext["logger"], "debug" | "error" | "info" | "warn">;

type LlmHookContext = Parameters<OpenClawPluginApi["on"]>[1] extends never ? never : {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: string;
  trigger?: string;
  channelId?: string;
};

type TurnMetadata = {
  runId?: string;
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  channelId?: string;
  trigger?: string;
  messageProvider?: string;
  provider?: string;
  model?: string;
  updatedAt: number;
};

type CallContext = TurnMetadata & {
  callId: string;
  callSequence: number;
  sessionId?: string;
  provider?: string;
  model?: string;
};

type StartParams = {
  pluginId: string;
  stateDir: string;
  workspaceDir?: string;
  defaultLogFile: string;
  logger: Logger;
};

type ActiveState = {
  pluginId: string;
  logger: Logger;
  config: ResolvedPluginConfig;
  writers: Map<string, JsonlWriter>;
};

type AgentLike = {
  _sessionId?: string;
  streamFn: (
    model: unknown,
    context: unknown,
    options?: Record<string, unknown>,
  ) => unknown;
};

type FetchRequestSummary = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
  truncated?: boolean;
  bodyBytes?: number;
};

type FetchResponseSummary = {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
  truncated?: boolean;
  bodyBytes?: number;
};

const GLOBAL_KEY = Symbol.for("llm-logger-openclaw-plugin.manager");
const WEBSOCKET_CALL_CONTEXT = Symbol.for("llm-logger-openclaw-plugin.wsCallContext");
const OBSERVED_WS_PATHS = ["/v1/responses"];
const TURN_METADATA_TTL_MS = 5 * 60 * 1000;
const UNKNOWN_SESSION_DIR = "_unknown_session";

type PatchHandles = {
  restore: () => void;
};

class PluginManager {
  #registrationLogger: Logger | null = null;
  #pluginConfig: PluginConfig = {
    enabled: true,
    maxBodyBytes: 262_144,
    redactAuthorization: true,
    includeHooks: true,
    includeHttp: true,
    includeWebSocket: true,
  };
  #activeState: ActiveState | null = null;
  #refCount = 0;
  #patchHandles: PatchHandles | null = null;
  #callContextStorage = new AsyncLocalStorage<CallContext>();
  #turnMetadataBySessionId = new Map<string, TurnMetadata>();

  setRegistrationLogger(logger: Logger): void {
    this.#registrationLogger = logger;
  }

  setPluginConfig(config: PluginConfig): void {
    this.#pluginConfig = config;
  }

  async start(params: StartParams): Promise<void> {
    this.#refCount += 1;
    if (this.#activeState) {
      return;
    }

    const config = finalizePluginConfig(this.#pluginConfig, params.defaultLogFile);
    this.#activeState = {
      pluginId: params.pluginId,
      logger: params.logger,
      config,
      writers: new Map(),
    };

    if (!config.enabled) {
      params.logger.info(`[${params.pluginId}] disabled by plugin config`);
      return;
    }

    try {
      this.#patchHandles = await this.#installPatches({
        workspaceDir: params.workspaceDir,
      });
      params.logger.info(
        `[${params.pluginId}] logging LLM traffic under session directories based on ${config.logFile} (maxBodyBytes=${config.maxBodyBytes})`,
      );
    } catch (error) {
      params.logger.warn(`[${params.pluginId}] failed to install runtime patches: ${this.#formatError(error)}`);
    }
  }

  async stop(): Promise<void> {
    this.#refCount = Math.max(0, this.#refCount - 1);
    if (this.#refCount > 0) {
      return;
    }

    this.#patchHandles?.restore();
    this.#patchHandles = null;

    if (this.#activeState) {
      await Promise.all(Array.from(this.#activeState.writers.values(), (writer) => writer.close()));
    }

    this.#activeState = null;
    this.#turnMetadataBySessionId.clear();
  }

  recordLlmInput(event: Record<string, unknown>, ctx: LlmHookContext): void {
    const state = this.#activeState;
    if (!state?.config.enabled || !state.config.includeHooks) {
      return;
    }

    const sessionId =
      typeof event.sessionId === "string" && event.sessionId.trim().length > 0
        ? event.sessionId
        : ctx.sessionId;
    if (sessionId) {
      this.#turnMetadataBySessionId.set(sessionId, {
        runId: typeof event.runId === "string" ? event.runId : undefined,
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey,
        workspaceDir: ctx.workspaceDir,
        channelId: ctx.channelId,
        trigger: ctx.trigger,
        messageProvider: ctx.messageProvider,
        provider: typeof event.provider === "string" ? event.provider : undefined,
        model: typeof event.model === "string" ? event.model : undefined,
        updatedAt: Date.now(),
      });
    }

    this.#write({
      eventType: "llm_input",
      sessionId,
      runId: typeof event.runId === "string" ? event.runId : undefined,
      provider: typeof event.provider === "string" ? event.provider : undefined,
      model: typeof event.model === "string" ? event.model : undefined,
      agentId: ctx.agentId,
      sessionKey: ctx.sessionKey,
      workspaceDir: ctx.workspaceDir,
      channelId: ctx.channelId,
      trigger: ctx.trigger,
      messageProvider: ctx.messageProvider,
      payload: this.#redact(event),
    });
  }

  recordLlmOutput(event: Record<string, unknown>, ctx: LlmHookContext): void {
    const state = this.#activeState;
    if (!state?.config.enabled || !state.config.includeHooks) {
      return;
    }

    const sessionId =
      typeof event.sessionId === "string" && event.sessionId.trim().length > 0
        ? event.sessionId
        : ctx.sessionId;

    this.#write({
      eventType: "llm_output",
      sessionId,
      runId: typeof event.runId === "string" ? event.runId : undefined,
      provider: typeof event.provider === "string" ? event.provider : undefined,
      model: typeof event.model === "string" ? event.model : undefined,
      agentId: ctx.agentId,
      sessionKey: ctx.sessionKey,
      workspaceDir: ctx.workspaceDir,
      channelId: ctx.channelId,
      trigger: ctx.trigger,
      messageProvider: ctx.messageProvider,
      payload: this.#redact(event),
    });
  }

  #logger(): Logger {
    return this.#activeState?.logger ?? this.#registrationLogger ?? console;
  }

  #currentConfig(): ResolvedPluginConfig | null {
    return this.#activeState?.config ?? null;
  }

  #currentCallContext(): CallContext | undefined {
    return this.#callContextStorage.getStore();
  }

  #shouldCaptureHttp(): boolean {
    return this.#currentConfig()?.enabled === true && this.#currentConfig()?.includeHttp === true;
  }

  #shouldCaptureWebSocket(): boolean {
    return (
      this.#currentConfig()?.enabled === true && this.#currentConfig()?.includeWebSocket === true
    );
  }

  #redact(value: unknown): unknown {
    const config = this.#currentConfig();
    return redactValue(value, config?.redactAuthorization !== false);
  }

  #mergeTurnMetadata(callContext: CallContext): CallContext {
    if (!callContext.sessionId) {
      return callContext;
    }

    const turnMetadata = this.#turnMetadataBySessionId.get(callContext.sessionId);
    if (!turnMetadata) {
      return callContext;
    }
    if (Date.now() - turnMetadata.updatedAt > TURN_METADATA_TTL_MS) {
      this.#turnMetadataBySessionId.delete(callContext.sessionId);
      return callContext;
    }
    if (
      turnMetadata.provider &&
      callContext.provider &&
      turnMetadata.provider !== callContext.provider
    ) {
      return callContext;
    }
    if (turnMetadata.model && callContext.model && turnMetadata.model !== callContext.model) {
      return callContext;
    }

    return {
      ...turnMetadata,
      ...callContext,
    };
  }

  async #installPatches(params: {
    workspaceDir?: string;
  }): Promise<PatchHandles> {
    const openClawRoot = resolveOpenClawRoot({
      workspaceDir: params.workspaceDir,
    });
    const openClawRequire = createRequire(path.join(openClawRoot, "package.json"));
    const agentModulePath = openClawRequire.resolve("@mariozechner/pi-agent-core");
    const agentModule = (await import(pathToFileURL(agentModulePath).href)) as {
      Agent?: {
        prototype: {
          _runLoop?: (...args: unknown[]) => Promise<unknown>;
        };
      };
    };
    const AgentCtor = agentModule.Agent;
    if (!AgentCtor?.prototype?._runLoop) {
      throw new Error("unable to locate Agent.prototype._runLoop");
    }

    const wsModule = openClawRequire("ws") as {
      prototype?: {
        send?: (...args: unknown[]) => unknown;
        emit?: (...args: unknown[]) => unknown;
      };
    };
    if (!wsModule?.prototype?.send || !wsModule?.prototype?.emit) {
      throw new Error("unable to locate ws prototype");
    }

    const originalRunLoop = AgentCtor.prototype._runLoop;
    const originalFetch = globalThis.fetch;
    const originalWsSend = wsModule.prototype.send;
    const originalWsEmit = wsModule.prototype.emit;

    const manager = this;

    AgentCtor.prototype._runLoop = async function patchedRunLoop(
      this: AgentLike,
      ...args: unknown[]
    ): Promise<unknown> {
      const originalStreamFn = this.streamFn;
      let callSequence = 0;

      this.streamFn = (model: unknown, context: unknown, options?: Record<string, unknown>) => {
        callSequence += 1;
        const baseContext = manager.#mergeTurnMetadata({
          callId: randomUUID(),
          callSequence,
          sessionId: typeof this._sessionId === "string" ? this._sessionId : undefined,
          provider: manager.#readString(model, "provider"),
          model: manager.#readString(model, "id"),
          updatedAt: Date.now(),
        });
        const previousOnPayload = options?.onPayload;
        const nextOptions = {
          ...options,
          onPayload: async (payload: unknown, payloadModel: unknown) => {
            manager.#write({
              eventType: "provider_request_payload",
              ...baseContext,
              payload: manager.#redact(payload),
              payloadModel:
                payloadModel && typeof payloadModel === "object"
                  ? manager.#redact(payloadModel)
                  : payloadModel,
            });
            if (typeof previousOnPayload === "function") {
              return await previousOnPayload(payload, payloadModel);
            }
            return undefined;
          },
        };

        return manager.#callContextStorage.run(baseContext, () =>
          originalStreamFn.call(this, model, context, nextOptions),
        );
      };

      try {
        return await originalRunLoop.apply(this, args);
      } finally {
        this.streamFn = originalStreamFn;
      }
    };

    globalThis.fetch = async function patchedFetch(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      const callContext = manager.#currentCallContext();
      if (!callContext || !manager.#shouldCaptureHttp()) {
        return originalFetch(input, init);
      }

      const startedAt = Date.now();
      const requestSummary = await manager.#summarizeFetchRequest(input, init);
      manager.#write({
        eventType: "http_request",
        ...callContext,
        request: requestSummary,
      });

      try {
        const response = await originalFetch(input, init);
        void manager.#captureFetchResponse(callContext, response, Date.now() - startedAt);
        return response;
      } catch (error) {
        manager.#write({
          eventType: "http_error",
          ...callContext,
          request: requestSummary,
          durationMs: Date.now() - startedAt,
          error: manager.#formatError(error),
        });
        throw error;
      }
    };

    wsModule.prototype.send = function patchedWsSend(
      this: Record<PropertyKey, unknown> & { url?: unknown },
      data: unknown,
      ...args: unknown[]
    ) {
      const callContext = manager.#currentCallContext();
      const url = typeof this.url === "string" ? this.url : undefined;
      if (callContext && url && manager.#shouldCaptureWebSocket() && manager.#isObservedWsUrl(url)) {
        this[WEBSOCKET_CALL_CONTEXT] = callContext;
        manager.#write({
          eventType: "ws_send",
          ...callContext,
          url,
          payload: manager.#summarizeSocketData(data),
        });
      }
      return originalWsSend.call(this, data, ...args);
    };

    wsModule.prototype.emit = function patchedWsEmit(
      this: Record<PropertyKey, unknown> & { url?: unknown },
      eventName: unknown,
      ...args: unknown[]
    ) {
      const url = typeof this.url === "string" ? this.url : undefined;
      if (
        eventName === "message" &&
        url &&
        manager.#shouldCaptureWebSocket() &&
        manager.#isObservedWsUrl(url)
      ) {
        const callContext = this[WEBSOCKET_CALL_CONTEXT] as CallContext | undefined;
        if (callContext) {
          manager.#write({
            eventType: "ws_message",
            ...callContext,
            url,
            payload: manager.#summarizeSocketData(args[0]),
            isBinary: Boolean(args[1]),
          });
        }
      }

      return originalWsEmit.call(this, eventName, ...args);
    };

    return {
      restore() {
        AgentCtor.prototype._runLoop = originalRunLoop;
        globalThis.fetch = originalFetch;
        wsModule.prototype?.send && (wsModule.prototype.send = originalWsSend);
        wsModule.prototype?.emit && (wsModule.prototype.emit = originalWsEmit);
      },
    };
  }

  #write(record: Record<string, unknown>): void {
    const state = this.#activeState;
    if (!state?.config.enabled) {
      return;
    }

    const event = {
      ts: new Date().toISOString(),
      plugin: state.pluginId,
      sessionId: this.#currentCallContext()?.sessionId,
      ...record,
    };
    const sessionId =
      typeof event.sessionId === "string" && event.sessionId.trim().length > 0
        ? event.sessionId
        : undefined;
    const writer = this.#getWriterForEvent(state, sessionId, new Date());

    void writer.write(event).catch((error) => {
      this.#logger().warn(`[${state.pluginId}] failed to write log entry: ${this.#formatError(error)}`);
    });
  }

  #getWriterForEvent(state: ActiveState, sessionId: string | undefined, now: Date): JsonlWriter {
    const sessionDir = this.#sanitizeSessionDirName(sessionId);
    const dateSuffix = this.#formatDateSuffix(now);
    const key = `${sessionDir}|${dateSuffix}`;
    const cachedWriter = state.writers.get(key);
    if (cachedWriter) {
      return cachedWriter;
    }

    const filePath = this.#buildSessionLogPath(state.config.logFile, sessionDir, dateSuffix);
    const writer = new JsonlWriter(filePath);
    state.writers.set(key, writer);
    return writer;
  }

  #buildSessionLogPath(baseLogFile: string, sessionDir: string, dateSuffix: string): string {
    const parsed = path.parse(baseLogFile);
    const ext = parsed.ext || ".jsonl";
    const baseName = parsed.name || "llm-log";
    const filename = `${baseName}-${dateSuffix}${ext}`;
    return path.join(parsed.dir, sessionDir, filename);
  }

  #sanitizeSessionDirName(sessionId: string | undefined): string {
    if (!sessionId) {
      return UNKNOWN_SESSION_DIR;
    }
    const normalized = sessionId.trim();
    if (!normalized) {
      return UNKNOWN_SESSION_DIR;
    }
    return normalized.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_");
  }

  #formatDateSuffix(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  async #captureFetchResponse(
    callContext: CallContext,
    response: Response,
    durationMs: number,
  ): Promise<void> {
    let summary: FetchResponseSummary = {
      status: response.status,
      headers: redactHeaders(
        this.#headersToRecord(response.headers),
        this.#currentConfig()?.redactAuthorization !== false,
      ),
    };

    try {
      const captured = await this.#captureResponseBody(response.clone());
      summary = {
        ...summary,
        ...captured,
      };
    } catch (error) {
      summary = {
        ...summary,
        body: `[capture failed: ${this.#formatError(error)}]`,
      };
    }

    this.#write({
      eventType: "http_response",
      ...callContext,
      durationMs,
      response: summary,
    });
  }

  async #summarizeFetchRequest(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<FetchRequestSummary> {
    const url = this.#resolveRequestUrl(input);
    const method = this.#resolveRequestMethod(input, init);
    const headers = redactHeaders(
      this.#resolveRequestHeaders(input, init),
      this.#currentConfig()?.redactAuthorization !== false,
    );
    const body = await this.#captureRequestBody(input, init);

    return {
      url,
      method,
      headers,
      ...(body ?? {}),
    };
  }

  #resolveRequestUrl(input: RequestInfo | URL): string {
    if (typeof input === "string") {
      return input;
    }
    if (input instanceof URL) {
      return input.toString();
    }
    if (typeof Request !== "undefined" && input instanceof Request) {
      return input.url;
    }
    return String(input);
  }

  #resolveRequestMethod(input: RequestInfo | URL, init?: RequestInit): string {
    if (typeof init?.method === "string" && init.method.trim().length > 0) {
      return init.method.toUpperCase();
    }
    if (typeof Request !== "undefined" && input instanceof Request) {
      return input.method.toUpperCase();
    }
    return "GET";
  }

  #resolveRequestHeaders(input: RequestInfo | URL, init?: RequestInit): Record<string, string> {
    const merged = new Headers();

    if (typeof Request !== "undefined" && input instanceof Request) {
      input.headers.forEach((value, key) => {
        merged.set(key, value);
      });
    }

    const initHeaders = new Headers(init?.headers ?? undefined);
    initHeaders.forEach((value, key) => {
      merged.set(key, value);
    });

    return this.#headersToRecord(merged);
  }

  async #captureRequestBody(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Partial<FetchRequestSummary> | undefined> {
    const maxBodyBytes = this.#currentConfig()?.maxBodyBytes ?? 262_144;

    if (init?.body !== undefined) {
      return await this.#captureBodyLike(init.body as Request | BodyInit, maxBodyBytes);
    }

    if (typeof Request !== "undefined" && input instanceof Request && !input.bodyUsed) {
      try {
        return await this.#captureBodyLike(input.clone(), maxBodyBytes);
      } catch (error) {
        return {
          body: `[capture failed: ${this.#formatError(error)}]`,
        };
      }
    }

    return undefined;
  }

  async #captureResponseBody(
    response: Response,
  ): Promise<Partial<FetchResponseSummary>> {
    if (!response.body) {
      return {};
    }

    const captured = await this.#readStreamLimit(response.body);
    return {
      body: this.#maybeParseJson(captured.text),
      truncated: captured.truncated,
      bodyBytes: captured.bodyBytes,
    };
  }

  async #captureBodyLike(
    body: BodyInit | Request,
    maxBodyBytes: number,
  ): Promise<Partial<FetchRequestSummary>> {
    if (typeof body === "string") {
      return this.#captureTextBody(body, maxBodyBytes);
    }
    if (body instanceof URLSearchParams) {
      return this.#captureTextBody(body.toString(), maxBodyBytes);
    }
    if (body instanceof ArrayBuffer) {
      return this.#captureBinaryBody(new Uint8Array(body), maxBodyBytes);
    }
    if (ArrayBuffer.isView(body)) {
      return this.#captureBinaryBody(new Uint8Array(body.buffer, body.byteOffset, body.byteLength), maxBodyBytes);
    }
    if (typeof Blob !== "undefined" && body instanceof Blob) {
      return this.#captureTextBody(await body.text(), maxBodyBytes);
    }
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      return {
        body: "[form-data]",
      };
    }
    if (typeof Request !== "undefined" && body instanceof Request) {
      return this.#captureTextBody(await body.text(), maxBodyBytes);
    }

    return {
      body: `[unsupported body type: ${Object.prototype.toString.call(body)}]`,
    };
  }

  #captureBinaryBody(
    buffer: Uint8Array,
    maxBodyBytes: number,
  ): Partial<FetchRequestSummary> {
    const truncated = buffer.byteLength > maxBodyBytes;
    const limited = truncated ? buffer.subarray(0, maxBodyBytes) : buffer;
    return {
      body: Buffer.from(limited).toString("base64"),
      truncated,
      bodyBytes: limited.byteLength,
    };
  }

  #captureTextBody(text: string, maxBodyBytes: number): Partial<FetchRequestSummary> {
    const buffer = Buffer.from(text, "utf8");
    const truncated = buffer.byteLength > maxBodyBytes;
    const limited = truncated ? buffer.subarray(0, maxBodyBytes) : buffer;

    return {
      body: this.#maybeParseJson(limited.toString("utf8")),
      truncated,
      bodyBytes: limited.byteLength,
    };
  }

  async #readStreamLimit(
    stream: ReadableStream<Uint8Array>,
  ): Promise<{ text: string; truncated: boolean; bodyBytes: number }> {
    const maxBodyBytes = this.#currentConfig()?.maxBodyBytes ?? 262_144;
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    let capturedBytes = 0;
    let truncated = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        totalBytes += chunk.byteLength;

        if (capturedBytes < maxBodyBytes) {
          const remaining = maxBodyBytes - capturedBytes;
          const slice = chunk.subarray(0, remaining);
          chunks.push(slice);
          capturedBytes += slice.byteLength;
        }

        if (totalBytes > maxBodyBytes) {
          truncated = true;
          void reader.cancel().catch(() => {});
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }

    return {
      text: new TextDecoder().decode(this.#concatUint8Arrays(chunks)),
      truncated,
      bodyBytes: capturedBytes,
    };
  }

  #concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
    const totalSize = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const merged = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged;
  }

  #headersToRecord(headers: Headers): Record<string, string> {
    const record: Record<string, string> = {};
    headers.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }

  #summarizeSocketData(data: unknown): unknown {
    const maxBodyBytes = this.#currentConfig()?.maxBodyBytes ?? 262_144;

    if (typeof data === "string") {
      return this.#captureTextBody(data, maxBodyBytes).body;
    }
    if (data instanceof ArrayBuffer) {
      return this.#captureBinaryBody(new Uint8Array(data), maxBodyBytes).body;
    }
    if (ArrayBuffer.isView(data)) {
      const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      return this.#maybeParseJson(Buffer.from(view.subarray(0, maxBodyBytes)).toString("utf8"));
    }
    return String(data);
  }

  #isObservedWsUrl(url: string): boolean {
    return OBSERVED_WS_PATHS.some((pathname) => url.includes(pathname));
  }

  #readString(value: unknown, key: string): string | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : undefined;
  }

  #maybeParseJson(text: string): unknown {
    const trimmed = text.trim();
    if (!trimmed) {
      return "";
    }
    try {
      return this.#redact(JSON.parse(trimmed));
    } catch {
      return trimmed;
    }
  }

  #formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.stack ?? error.message;
    }
    return String(error);
  }
}

export function getPluginManager(): PluginManager {
  const globalStore = globalThis as typeof globalThis & {
    [GLOBAL_KEY]?: PluginManager;
  };
  if (!globalStore[GLOBAL_KEY]) {
    globalStore[GLOBAL_KEY] = new PluginManager();
  }
  return globalStore[GLOBAL_KEY]!;
}
