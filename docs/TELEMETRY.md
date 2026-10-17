# OpenLLM / OTLP Telemetry

Optional OpenTelemetry exporter for MCP tool calls and in-process agent turns. When enabled, ExpressMcp batches GenAI / OpenInference spans and exports them as a standard OTLP `ExportTraceServiceRequest`.

Telemetry is constructor config only — the same pattern as `auth` and `agent`. There is no env auto-read and **no protocol inference** from the URL.

## Same payload; choose the wire explicitly

There is **no separate LLM protocol or endpoint**. An “LLM trace” is a standard OpenTelemetry trace whose spans carry specialized attributes (`gen_ai.*`, `openinference.*`). The span model is always the same; collectors differ only in **encoding and transport**. Set `telemetry.protocol` to one of the OTLP names:

| `protocol` | Wire | Typical collectors |
| --- | --- | --- |
| `http/json` | `POST /v1/traces` with `Content-Type: application/json` | OTLP Collector JSON receiver, Jaeger, any OTLP/HTTP JSON endpoint |
| `http/protobuf` | `POST /v1/traces` with `Content-Type: application/x-protobuf` | Phoenix Cloud, many cloud OTLP collectors |
| `grpc` | gRPC `TraceService/Export` (optional peer `@grpc/grpc-js`) | OpenTelemetry Collector on port 4317, etc. |

Missing or unknown `protocol` when `enabled: true` **throws at construct**. Do not set `OTEL_EXPORTER_OTLP_PROTOCOL` — ExpressMcp never reads it.

### Regular APM span vs LLM span

Both live in the same OTLP envelope (`resourceSpans` → `scopeSpans` → `spans`). On the JSON wire, attributes use AnyValue wrappers (`stringValue`, `intValue`, `boolValue`). Protobuf uses the same fields as bytes / typed values.

**Regular APM (HTTP):**

```json
{
  "name": "GET /api/orders",
  "kind": 2,
  "attributes": [
    { "key": "http.method", "value": { "stringValue": "GET" } },
    { "key": "http.route", "value": { "stringValue": "/api/orders" } }
  ]
}
```

**ExpressMcp TOOL span:**

```json
{
  "name": "mcp.tool.knowledge_base_search",
  "kind": 1,
  "attributes": [
    { "key": "openinference.span.kind", "value": { "stringValue": "TOOL" } },
    { "key": "gen_ai.system", "value": { "stringValue": "express_mcp" } },
    { "key": "gen_ai.tool.name", "value": { "stringValue": "knowledge_base_search" } },
    { "key": "input.value", "value": { "stringValue": "{\"query\":\"refund policy\"}" } }
  ]
}
```

(`kind: 1` = `SPAN_KIND_INTERNAL`, `kind: 2` = `SPAN_KIND_SERVER`.)

### One trace tree

W3C `traceparent` stitches host APM spans and ExpressMcp GenAI spans into a single journey:

```
[SERVER]  POST /mcp                         ← host / Express auto-instrumentation (not this library)
 └── [CHAIN] agent.process_message         ← express_mcp (OpenInference CHAIN)
      ├── [LLM] gen_ai.generateContent     ← express_mcp (one per model round)
      ├── [TOOL] mcp.tool.kb_search        ← express_mcp (OpenInference TOOL)
      ├── [TOOL] mcp.tool.request_tools    ← express_mcp (escalation)
      └── [LLM] gen_ai.generateContent     ← …
           └── [DB] flexsearch.search      ← host instrumentation under the tool (not this library)
```

**This library emits CHAIN, LLM, and TOOL spans** (including synthetic `mcp.tool.request_tools` for escalation). Host HTTP/DB spans nest in the **same** `traceId` when they propagate `traceparent`. LLM and TOOL children are siblings under the CHAIN (tools are not nested under LLM spans).

### Why LLM spans need extra care

| Characteristic | Regular APM | LLM / MCP spans |
| --- | --- | --- |
| Payload size | Small (~200–800 B) | Large (prompts, tool JSON) |
| Latency | Milliseconds | Seconds |
| Cardinality | Low (`GET /users/:id`) | High (`input.value` is unique text) |

That is why ExpressMcp **batches**, **truncates** (`maxAttributeLength`), and **redacts** (`sanitizeKeys`) before export — not because LLM tracing uses a different transport.

## Quick start (Phoenix Cloud)

Phoenix Cloud expects **http/protobuf**. JSON `POST /v1/traces` to the space origin is treated as the web app (HTTP 302 `/login`). ExpressMcp does not read `PHOENIX_*` or `OTEL_EXPORTER_OTLP_*` env vars — pass constructor options:

```javascript
import express from 'express';
import { ExpressMcp, BaseTool } from '@brandon-svec/express_mcp';

const expressMcp = new ExpressMcp({
  name: 'my-service',
  telemetry: {
    enabled: true,
    protocol: 'http/protobuf',
    // Origin only — library appends /v1/traces for HTTP protocols
    endpoint: 'https://app.phoenix.arize.com/s/<space-id>',
    headers: {
      Authorization: 'Bearer <YOUR_PHOENIX_API_KEY>',
      'phx-project-name': 'default',
    },
    serviceName: 'my-service',
  },
});

expressMcp.registerTool(new MyTool());

const app = express();
app.use(express.json());
app.use('/mcp', expressMcp.router());

const server = app.listen(3000);

process.once('SIGTERM', async () => {
  await expressMcp.close(); // drain queued spans, destroy keep-alive sockets
  server.close();
});
```

Hosts that use a `config` package should pass `config.get('…')` into `options.telemetry` — this library never reads `process.env` for telemetry.

## Where to send it

### Arize Phoenix Cloud

See [Quick start (Phoenix Cloud)](#quick-start-phoenix-cloud). Summary:

| Item | Value |
| --- | --- |
| Collector origin | Space URL, e.g. `https://app.phoenix.arize.com/s/<space-id>` (library appends `/v1/traces`) |
| Auth | `Authorization: Bearer <api key>` |
| Protocol | `http/protobuf` |
| Project | `phx-project-name` header (Phoenix UI project; often `default`) |

Host `/v1/traces` on `app.phoenix.arize.com` (no `/s/<handle>`) returns **HTTP 410** — Phoenix apps are addressed at `/s/<handle>`.

ExpressMcp sends `User-Agent: OTel-OTLP-Exporter-Node/<version>` on HTTP exports (host `headers['user-agent']` still wins). Cloudflare / GCLB in front of Phoenix Cloud treats generic clients such as `got`'s default User-Agent as UI scrapers and **302**s them to `/login` before uvicorn. HTTP exports set `followRedirect: false` and throw on 3xx so a mis-routed redirect fails open immediately instead of looping.

Create a key at your Phoenix workspace settings (e.g. `https://app.phoenix.arize.com/…/settings/api-keys`). Space Settings → API Keys & Collector typically shows `PHOENIX_COLLECTOR_ENDPOINT=https://app.phoenix.arize.com/s/<space>` — pass that origin as `telemetry.endpoint`.

`npm test` stays offline (hermetic mock collector).

### gRPC collectors

```javascript
telemetry: {
  enabled: true,
  protocol: 'grpc',
  endpoint: 'http://localhost:4317', // or https://collector:443 — no /v1/traces
  headers: { Authorization: 'Bearer <key>' },
}
```

Install the optional peer: `npm install @grpc/grpc-js`. Missing peer throws at construct. Port defaults when omitted: `https` → `:443`, `http` → `:80` (no silent `:4317`).

### Any OTLP collector

Jaeger OTLP, Grafana Alloy, OpenTelemetry Collector, etc. Pick `protocol` to match the receiver. One collector can receive both APM and LLM spans when they share a `traceId`.

## Config reference

| Field | Required when `enabled: true` | Default | Description |
| --- | --- | --- | --- |
| `enabled` | — | omit / not `true` = off | Must be exactly `true` to start the exporter |
| `protocol` | Yes | — | `http/json`, `http/protobuf`, or `grpc` (no inference) |
| `endpoint` | Yes | — | HTTP: origin or full `/v1/traces` URL. gRPC: `http(s)://host[:port]` (path stripped) |
| `headers` | No | `{}` | Extra HTTP headers or gRPC metadata (e.g. Authorization) |
| `serviceName` | No | `options.name` or `express-mcp` | Resource attribute `service.name` |
| `captureParameters` | No | `true` | Include sanitized `input.value` |
| `captureResults` | No | `true` | Include sanitized `output.value` |
| `maxAttributeLength` | No | `4096` | Max characters for stringified attributes |
| `sanitizeKeys` | No | `password`, `secret`, `token`, `authorization`, `apiKey` | Key names redacted to `[REDACTED]` at any depth (case-insensitive) |
| `batchMaxSpans` | No | `50` | Flush when the queue reaches this many spans |
| `batchTimeoutMs` | No | `1000` | Max wait before a background flush |
| `maxQueueSize` | No | `1000` | Bounded queue; drops oldest when full |
| `maxSockets` | No | `10` | Max keep-alive TCP sockets |
| `keepAliveTimeoutMs` | No | `30000` | HTTP(S) keep-alive duration |
| `maxRetries` | No | `3` | Retries on 429 / 502 / 503 / 504 (honors `Retry-After`) |
| `requestTimeoutMs` | No | `5000` | Timeout per dispatch attempt |

When `enabled` is not `true`, no sockets or flush timers are created. When `enabled: true` and `endpoint` is missing, the constructor **throws**.

## How clients interact

### MCP HTTP clients (Cursor, etc.)

Send W3C `traceparent` on the request:

- HTTP header: `traceparent: 00-<traceId>-<spanId>-01`
- and/or JSON-RPC `_meta.traceparent`

Tool spans become children of that parent (`traceId` preserved, `parentSpanId` = upstream span id).

### In-process agent

`getAgent().processMessage(...)` emits a CHAIN span `agent.process_message` with `mcp.session_id` set to the history key. Each `adapter.generate` round emits a child LLM span `gen_ai.generateContent`. Nested tool calls and `request_tools` escalations are TOOL siblings of those LLM spans under the same CHAIN. Paths with no inbound `traceparent` (e.g. Telegram bots) start a new root CHAIN.

Manual Phoenix verification uses constructor config only — for example `telemetry: { enabled: true, protocol: 'http/protobuf', endpoint: 'https://app.phoenix.arize.com/s/<space>', headers: { Authorization: 'Bearer …', 'phx-project-name': '…' } }`. ExpressMcp does not read `OTEL_EXPORTER_OTLP_*`.

### Shutdown

Call `await expressMcp.close()` on process shutdown to drain the batch queue and destroy keep-alive agents. Without it, the last batch may be dropped.

### Verify with curl

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"hello","arguments":{"name":"Ada"}}}'
```

(Use a real MCP session: initialize first, then pass `mcp-session-id`.) Confirm Phoenix (or your collector) received `traceId` = `4bf92f3577b34da6a3ce929d0e0e4736`.

## Span attributes

### TOOL (`mcp.tool.<name>`)

| Attribute | Description |
| --- | --- |
| `openinference.span.kind` | `"TOOL"` |
| `gen_ai.system` | `"express_mcp"` |
| `gen_ai.tool.name` | Tool name |
| `gen_ai.operation.name` | `"execute_tool"` |
| `mcp.session_id` | MCP session id when present |
| `mcp.tool.status` | `"success"` or `"error"` |
| `mcp.tool.duration_ms` | Duration in milliseconds |
| `input.value` / `output.value` | Sanitized JSON (when capture flags are on) |
| `user.id` | Authenticated JWT `sub` when auth is enabled |
| `error.message` / `error.code` | On failure |

### CHAIN (`agent.process_message`)

| Attribute | Description |
| --- | --- |
| `openinference.span.kind` | `"CHAIN"` |
| `gen_ai.system` | `"gemini"` for `GeminiAdapter`, else `"custom"` |
| `gen_ai.operation.name` | `"process_message"` |
| `mcp.session_id` | Agent history key / session id |
| `input.value` / `output.value` | Prompt and final reply (when capture flags are on) |
| `agent.rounds` | Tool-loop round count |
| `agent.escalated` | `true` when `request_tools` ran this turn |
| `agent.escalation_reason` | Sanitized reason from `request_tools` |
| `agent.self_corrections` | Count of Stop-hook reject-and-retry iterations (omitted when 0) |
| `gen_ai.usage.input_tokens` / `output_tokens` / `total_tokens` | Sum across LLM rounds when the adapter reports usage |
| `user.id` | JWT `sub` when present |

### LLM (`gen_ai.generateContent`)

| Attribute | Description |
| --- | --- |
| `openinference.span.kind` | `"LLM"` |
| `gen_ai.system` | `"gemini"` or `"custom"` |
| `gen_ai.operation.name` | `"generateContent"` |
| `gen_ai.request.model` | Adapter model id when present |
| `agent.round` | Zero-based generate round index |
| `mcp.session_id` | Same session id as the CHAIN |
| `gen_ai.usage.input_tokens` / `output_tokens` / `total_tokens` | Per-round usage when reported (omitted when absent) |
| `gen_ai.thought` | Thinking-model reasoning text (`part.thought === true`), when `captureResults` is on |
| `output.value` | Function-call summary or final text (when `captureResults` is on) |

### Escalation TOOL (`mcp.tool.request_tools`)

Synthetic TOOL child when the model calls `request_tools`. Also sets `agent.escalated` / `agent.escalation_reason` on the parent CHAIN for aggregate filters.

Sensitive keys matching `sanitizeKeys` are replaced with `[REDACTED]`. Strings longer than `maxAttributeLength` are truncated.

## Fail-open / fail-fast / batching

- **Fail-fast at construct:** `enabled: true` without a valid `endpoint` throws.
- **Fail-open at runtime:** export/network errors are logged at debug and never interrupt MCP tool or agent execution.
- **Retries:** 429 / 502 / 503 / 504 with exponential backoff; `Retry-After` is honored.
- **Queue full:** drop oldest spans (`maxQueueSize`).
- **Batching:** flush when `batchMaxSpans` is reached **or** `batchTimeoutMs` elapses (default ~1–2 POSTs/sec instead of one POST per span). Keep-alive `http`/`https` agents reuse TCP connections.

## Advanced

`TelemetryEngine` and `normalizeTelemetryConfig` are exported from the package for tests and custom wiring. Prefer `options.telemetry` on `ExpressMcp` for normal hosts.
