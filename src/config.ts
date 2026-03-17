const DEFAULT_MAX_BODY_BYTES = 262_144;

export type PluginConfig = {
  enabled: boolean;
  logFile?: string;
  maxBodyBytes: number;
  redactAuthorization: boolean;
  includeHooks: boolean;
  includeHttp: boolean;
  includeWebSocket: boolean;
};

type Issue = {
  path: Array<string | number>;
  message: string;
};

type SafeParseResult =
  | { success: true; data: PluginConfig | undefined }
  | { success: false; error: { issues: Issue[] } };

export type ResolvedPluginConfig = PluginConfig & {
  logFile: string;
};

function error(message: string): SafeParseResult {
  return {
    success: false,
    error: {
      issues: [{ path: [], message }],
    },
  };
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeMaxBodyBytes(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 1024) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed >= 1024) {
      return parsed;
    }
  }
  return DEFAULT_MAX_BODY_BYTES;
}

export function resolvePluginConfig(value: unknown): PluginConfig {
  const parsed = pluginConfigSchema.safeParse(value);
  if (!parsed.success) {
    return {
      enabled: true,
      maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
      redactAuthorization: true,
      includeHooks: true,
      includeHttp: true,
      includeWebSocket: true,
    };
  }
  return (
    parsed.data ?? {
      enabled: true,
      maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
      redactAuthorization: true,
      includeHooks: true,
      includeHttp: true,
      includeWebSocket: true,
    }
  );
}

export function finalizePluginConfig(
  config: PluginConfig,
  defaultLogFile: string,
): ResolvedPluginConfig {
  return {
    ...config,
    logFile: config.logFile?.trim() || defaultLogFile,
  };
}

export const pluginConfigSchema = {
  safeParse(value: unknown): SafeParseResult {
    if (value === undefined) {
      return { success: true, data: undefined };
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return error("expected config object");
    }

    const record = value as Record<string, unknown>;
    const unknownKeys = Object.keys(record).filter(
      (key) =>
        ![
          "enabled",
          "logFile",
          "maxBodyBytes",
          "redactAuthorization",
          "includeHooks",
          "includeHttp",
          "includeWebSocket",
        ].includes(key),
    );
    if (unknownKeys.length > 0) {
      return error(`unknown config keys: ${unknownKeys.join(", ")}`);
    }

    return {
      success: true,
      data: {
        enabled: normalizeBoolean(record.enabled, true),
        logFile: normalizeString(record.logFile),
        maxBodyBytes: normalizeMaxBodyBytes(record.maxBodyBytes),
        redactAuthorization: normalizeBoolean(record.redactAuthorization, true),
        includeHooks: normalizeBoolean(record.includeHooks, true),
        includeHttp: normalizeBoolean(record.includeHttp, true),
        includeWebSocket: normalizeBoolean(record.includeWebSocket, true),
      },
    };
  },
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean", default: true },
      logFile: { type: "string" },
      maxBodyBytes: { type: "integer", minimum: 1024, default: DEFAULT_MAX_BODY_BYTES },
      redactAuthorization: { type: "boolean", default: true },
      includeHooks: { type: "boolean", default: true },
      includeHttp: { type: "boolean", default: true },
      includeWebSocket: { type: "boolean", default: true },
    },
  },
};
