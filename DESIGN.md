# llm-logger-openclaw-plugin 需求与设计文档

## 1. 目标

开发一个 OpenClaw 原生插件 `llm-logger-openclaw-plugin`。

插件安装并启用后，应当能够把 OpenClaw 对话过程中触发的底层 LLM 调用信息写入指定日志文件，包括：

- LLM 调用前的请求参数
- LLM 调用后的返回响应数据
- 与该次调用相关的基础上下文信息

日志应尽量覆盖 OpenClaw 对话主链路中的所有模型调用，而不是只记录最终回复。

## 2. 用户需求拆解

用户的原始需求可以拆成以下可验证目标：

1. 插件是一个独立项目，路径为 `/root/projects/llm-logger-openclaw-plugin`。
2. 插件遵循 OpenClaw 插件规范，可被 `openclaw plugins install` / `openclaw plugins enable` 使用。
3. 插件启用后，不需要修改 OpenClaw 核心源码。
4. 插件可以把日志写到用户指定文件。
5. 日志内容至少包含：
   - provider
   - model
   - 调用发生时间
   - 请求 payload
   - 响应 payload
   - OpenClaw 会话上下文标识
6. 日志格式应当便于后续机器分析，优先使用 JSON Lines。

## 3. 对 OpenClaw 源码的调研结论

### 3.1 已有插件 hook

OpenClaw 已经提供 typed hooks：

- `llm_input`
- `llm_output`

但这两个 hook 只能拿到“规范化后的输入/输出摘要”，例如：

- `prompt`
- `historyMessages`
- `assistantTexts`
- `usage`

它们不能直接拿到底层 provider 的原始请求体和原始响应体，因此单独依赖这两个 hook 不足以满足需求。

### 3.2 插件服务能力

OpenClaw 插件支持 `registerService()`。服务会在网关启动后常驻运行，因此适合做运行时拦截和 monkey patch。

这意味着插件可以在不修改核心源码的前提下，对运行时共享依赖增加日志能力。

### 3.3 Agent 内部存在 `onPayload`

OpenClaw 依赖的 `@mariozechner/pi-agent-core` / `@mariozechner/pi-ai` 已支持 `onPayload` 回调。

该回调可以拿到 provider 实际发送前的 payload，包括：

- HTTP provider 的请求对象
- OpenAI Responses WebSocket 路径下的 `response.create` payload

OpenClaw 核心目前没有把这个能力直接暴露为插件 hook，但可以通过对共享 `Agent` 原型打补丁统一接入。

### 3.4 返回响应的采集路径

底层响应存在两条主要链路：

1. HTTP / fetch 链路
   - 大多数 provider 走这条路径
   - 可以通过包装 `globalThis.fetch` 记录请求与响应
2. OpenAI Responses WebSocket 链路
   - OpenClaw 对 `openai/openai-responses` 存在专门的 WebSocket 快速路径
   - 这条路径不走 `fetch`
   - 需要补充 `ws` 层的发送/接收日志

## 4. 设计目标

### 4.1 功能目标

- 记录每一次底层 LLM 请求 payload
- 记录对应的底层响应数据
- 记录 OpenClaw 视角的会话/模型上下文
- 支持配置日志文件路径
- 支持基础脱敏与截断，避免日志无限膨胀

### 4.2 非目标

以下内容不作为第一版目标：

- 不实现日志轮转
- 不实现远程日志上报
- 不实现 UI 面板
- 不保证覆盖 OpenClaw 之外的任意第三方插件自定义网络请求

## 5. 总体方案

插件由三部分组成：

1. `typed hooks`
   - 使用 `llm_input` / `llm_output`
   - 记录 OpenClaw 语义层的调用边界和摘要信息
2. `service runtime patch`
   - 在插件服务启动时，对共享运行时打补丁
   - 统一补进“底层请求/响应”日志能力
3. `JSONL writer`
   - 统一输出到指定日志文件
   - 每条事件一行 JSON

## 6. 核心技术方案

### 6.1 对 `Agent.prototype` 打补丁

目标：

- 在每次实际 LLM 调用前创建一段“调用上下文”
- 把 `onPayload` 回调接入到现有 `streamFn`
- 为后续 `fetch` / `ws` 拦截提供关联上下文

实现方式：

1. 解析 OpenClaw 当前运行时使用的 `@mariozechner/pi-agent-core` 实际路径。
2. 加载同一个模块实例。
3. patch `Agent.prototype._runLoop`。
4. 在 `_runLoop` 执行期间临时包装 `this.streamFn`。
5. 每当 `streamFn(model, context, options)` 被调用时：
   - 生成一个插件内部 `callId`
   - 建立 AsyncLocalStorage 上下文
   - 包装 `options.onPayload`
   - 记录 `provider_request_payload` 事件

这样可以覆盖一次用户 prompt 内部的多次 LLM 调用，而不是只覆盖最外层一次。

### 6.2 AsyncLocalStorage 关联上下文

因为底层网络调用发生在异步链路中，需要一个轻量关联机制，把：

- sessionId
- provider
- model
- callId
- 调用序号

传递到 `fetch` 和 `ws` 拦截层。

方案：

- 使用 `AsyncLocalStorage<CallContext>`
- 每次 `streamFn` 调用时进入新的上下文
- 后续网络层日志自动读取当前上下文

### 6.3 包装 `globalThis.fetch`

目标：

- 记录 HTTP provider 的请求和响应

记录内容：

- 请求：
  - url
  - method
  - headers
  - body 文本或可序列化摘要
- 响应：
  - status
  - headers
  - body 文本截断内容

实现要求：

- 只在当前存在 AsyncLocalStorage 调用上下文时记录，避免污染无关请求
- 对敏感 header 做脱敏
- 对 body 做最大字节截断
- 对响应使用 `clone()` 或副本流读取，不能破坏原始消费链

### 6.4 包装 `ws` 模块

目标：

- 记录 OpenAI Responses WebSocket 路径下的发送和接收数据

实现方式：

1. 解析 OpenClaw 当前运行时实际使用的 `ws` 模块路径
2. patch 同一个 `WebSocket.prototype`
3. 包装：
   - `send()`
   - `emit("message", ...)`

筛选条件：

- 仅记录 `url` 命中 OpenAI Responses 路径的连接
- 优先记录文本帧

记录内容：

- outbound frame
- inbound frame
- 当前 `callId`
- 当前 `sessionId/provider/model`

说明：

WebSocket 返回的是事件流，不一定天然存在一个“单个完整响应体”。因此第一版会按帧记录；同时用 `llm_output` 事件补充最终输出摘要。

## 7. 日志模型设计

日志采用 JSONL，每行一条事件。

### 7.1 通用字段

所有事件尽量包含：

- `ts`: ISO 时间戳
- `plugin`: 固定为 `llm-logger-openclaw-plugin`
- `eventType`
- `callId`
- `sessionId`
- `provider`
- `model`

### 7.2 事件类型

第一版计划输出以下事件：

1. `llm_input`
   - OpenClaw 规范化输入摘要
2. `provider_request_payload`
   - `onPayload` 捕获到的 provider 请求对象
3. `http_request`
   - `fetch` 级别请求
4. `http_response`
   - `fetch` 级别响应
5. `ws_send`
   - WebSocket 发送帧
6. `ws_message`
   - WebSocket 接收帧
7. `llm_output`
   - OpenClaw 规范化输出摘要

### 7.3 响应体截断策略

为了避免日志文件无限膨胀：

- 默认对 request/response body 设置最大采集字节数
- 超限后写入：
  - `truncated: true`
  - `capturedBytes`
  - `originalLength`（若可得）

## 8. 配置设计

插件配置放在：

- `plugins.entries.llm-logger-openclaw-plugin.config`

第一版配置项：

- `enabled`: boolean，默认 `true`
- `logFile`: string，必填，日志文件路径
- `maxBodyBytes`: number，默认 `262144`
- `redactAuthorization`: boolean，默认 `true`
- `includeHooks`: boolean，默认 `true`
- `includeHttp`: boolean，默认 `true`
- `includeWebSocket`: boolean，默认 `true`

备注：

- 插件启用由 OpenClaw 本身控制
- `enabled` 是插件内部软开关，便于临时停用

## 9. 脱敏规则

默认脱敏以下字段：

- `authorization`
- `api-key`
- `x-api-key`
- `proxy-authorization`
- JSON body 中常见字段：
  - `apiKey`
  - `token`
  - `access_token`
  - `refresh_token`
  - `secret`
  - `password`

脱敏策略：

- header 统一替换为 `[REDACTED]`
- JSON 中命中敏感键的值替换为 `[REDACTED]`

## 10. 已知限制

### 10.1 `llm_input/llm_output` 不是逐次底层调用

这两个 hook 更接近“外层 agent turn”，不是一次用户 prompt 内部所有 tool loop 的逐次底层请求。因此它们只能作为摘要和边界补充。

### 10.2 WebSocket 返回按帧记录

OpenAI Responses WebSocket 路径第一版按帧记录，而不是强制拼装为单个完整响应对象。

### 10.3 仅保证 OpenClaw 主对话链路

插件第一版的保证范围是 OpenClaw 主对话链路中的 LLM 调用。对于完全脱离 Agent 调用上下文的自定义后台请求，不保证记录。

## 11. 实施计划

### 阶段 1

- 建立插件项目结构
- 提供 `openclaw.plugin.json`
- 提供基础配置 schema

### 阶段 2

- 实现 JSONL writer
- 实现脱敏与截断工具

### 阶段 3

- 实现 typed hooks：`llm_input` / `llm_output`
- 实现服务启动与停止

### 阶段 4

- 实现 `Agent.prototype` patch
- 实现 `fetch` patch
- 实现 `ws` patch

### 阶段 5

- 做本地静态验证
- 输出安装与配置说明

## 12. 交付标准

满足以下条件视为完成：

1. 插件目录具备完整可加载结构
2. OpenClaw 可以识别插件 manifest
3. 插件启用后能写出 JSONL 日志
4. 日志中可以看到：
   - 一次规范化 `llm_input`
   - 至少一次底层请求事件
   - 至少一次底层响应事件
   - 一次规范化 `llm_output`
5. 日志文件路径可通过插件配置指定

