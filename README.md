# llm-logger-openclaw-plugin

OpenClaw 插件。

启用后会把 OpenClaw 对话链路中的底层 LLM 调用请求参数和响应数据写入 JSONL 日志文件。

## 功能

- 记录 provider 请求 payload
- 记录 HTTP 请求与响应
- 记录 OpenAI Responses WebSocket 收发帧
- 记录 OpenClaw 的 `llm_input` / `llm_output` 摘要事件

## 安装

```bash
openclaw plugins install -l /root/projects/llm-logger-openclaw-plugin
openclaw plugins enable llm-logger-openclaw-plugin
```

## 配置

在 OpenClaw 配置中加入：

```json
{
  "plugins": {
    "entries": {
      "llm-logger-openclaw-plugin": {
        "enabled": true,
        "config": {
          "logFile": "/tmp/openclaw-llm.jsonl",
          "maxBodyBytes": 262144,
          "redactAuthorization": true,
          "includeHooks": true,
          "includeHttp": true,
          "includeWebSocket": true
        }
      }
    }
  }
}
```

如果不指定 `logFile`，默认写到：

```text
<OPENCLAW_STATE_DIR>/logs/llm-logger-openclaw-plugin.jsonl
```

## 日志格式

日志为 JSON Lines。

常见事件类型：

- `llm_input`
- `provider_request_payload`
- `http_request`
- `http_response`
- `ws_send`
- `ws_message`
- `llm_output`

## 说明

- 日志默认会对常见认证字段做脱敏
- 请求/响应 body 默认按 `maxBodyBytes` 截断
- WebSocket 路径按帧记录，不强制拼装成单一完整响应
