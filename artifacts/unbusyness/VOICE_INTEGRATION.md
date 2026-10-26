# Unbusyness Voice Integration

This document is for the team that builds the voice agent. It describes the only way a voice agent talks to Unbusyness.

## Principles

1. **The agent never touches the database.** It only uses the HTTPS endpoints below. It gets no database credentials and no Unbusyness API keys.
2. **Provider-agnostic.** Retell, Vapi, ElevenLabs and any platform that can send a webhook are supported. Each provider has a small adapter that translates its format into one Unbusyness contract. The core system never knows which provider answered.
3. **The owner stays in control.** The agent never quotes prices. Bookings it makes are *requested* and wait for the owner's confirmation. The customer is told the office will confirm.
4. **Replaceable.** To switch providers, the owner changes one setting (Settings › Voice agent) and pastes the new URLs into the new provider's dashboard. Nothing else changes.

```
Voice platform (Retell / Vapi / ElevenLabs / other)
      │   HTTPS, signed
      ▼
/api/voice/{provider}/{businessKey}/events      ← after every call
/api/voice/{provider}/{businessKey}/tools/...   ← during a call
      │   adapter: provider format ⇄ Unbusyness contract
      ▼
Unbusyness core: customers, calls, tasks, quotes, jobs
```

`{provider}` is one of `retell`, `vapi`, `elevenlabs`, `generic`. `{businessKey}` identifies the business. The owner copies both URLs from **Settings › Voice agent**.

## Authentication

Every request must pass one of the following checks:

| Method | How |
|---|---|
| Unbusyness secret | Header `X-Unbusyness-Secret: <secret>` (or `Authorization: Bearer <secret>`, or `?secret=<secret>` in the URL) |
| Retell signature | `x-retell-signature: v=<ms>,d=<hex>`, where hex = HMAC-SHA256(Retell API key, rawBody + ms). The owner stores the API key (the one with the webhook badge) as the "platform secret". |
| Vapi | `x-vapi-secret` header equal to the platform secret, or equal to the Unbusyness secret |
| ElevenLabs signature | `ElevenLabs-Signature: t=<sec>,v0=<hex>`, where hex = HMAC-SHA256(webhook secret, t + "." + rawBody) |

Failed checks return `401` and are logged in **Settings › Voice agent › Recent deliveries**.

## 1. After the call: `POST …/events`

Send one event per finished call. Unbusyness creates or updates the customer, saves the call, and creates the next step:

- **Quote request:** a draft quote is created from the owner's price list.
- **Emergency or high urgency:** an urgent call-back task is created, and the owner gets an SMS and an email.
- **Question:** a call-back task is created.
- **New job:** a "book this customer" task is created, unless a booking was already requested during the call. In that case the call is linked to it.

The same `call_id` twice is ignored (retries are safe). Respond time is short; a `500` means "retry later".

### Provider formats

| Provider | Event Unbusyness uses | Where the fields come from |
|---|---|---|
| Retell | `call_analyzed` (enable it in the webhook settings; other events are ignored) | `call.call_id`, `call.from_number`, `call.transcript`, `call.recording_url`, `call.call_analysis.call_summary`, `call.call_analysis.custom_analysis_data.*` |
| Vapi | `message.type = "end-of-call-report"` | `message.call.id`, `message.call.customer.number`, `message.analysis.summary`, `message.analysis.structuredData.*`, `message.artifact.transcript`, `message.artifact.recordingUrl` |
| ElevenLabs | `type = "post_call_transcription"` | `data.conversation_id`, `data.analysis.transcript_summary`, `data.analysis.data_collection_results.*`, `data.transcript[]`, `data.metadata.phone_call.external_number` |
| Generic | any JSON in the format below | top-level fields |

### Fields to extract (post-call analysis / structured data / data collection)

Configure the agent's analysis with these names (common synonyms such as `name`, `issue` or `priority` are also understood):

| Field | Type | Values / example |
|---|---|---|
| `customer_name` | string | "Sarah Miller" |
| `customer_email` | string | optional |
| `address` | string | "18 Maple Street, Austin, TX" |
| `intent` | enum | `new_job`, `quote_request`, `question`, `emergency`, `other` |
| `service` | string | "Leaking kitchen sink" |
| `urgency` | enum | `low`, `normal`, `high`, `emergency` |
| `preferred_time` | string | "tomorrow morning" |

The caller's phone number is taken from the provider's call data automatically.

### Generic format

```json
{
  "call_id": "abc123",
  "from_phone": "+15125550148",
  "customer_name": "Sarah Miller",
  "customer_email": "sarah@example.com",
  "address": "18 Maple Street, Austin, TX",
  "intent": "new_job",
  "service": "Leaking kitchen sink",
  "urgency": "high",
  "preferred_time": "tomorrow morning",
  "summary": "Water leaking under the kitchen sink, valve turned off.",
  "transcript": "Agent: ...\nCaller: ...",
  "recording_url": "https://...",
  "duration_sec": 140
}
```

Only `summary` plus either `from_phone` or `customer_name` are really needed.

## 2. During the call: tools

Five tools are available. Each returns JSON with `ok`, `data` and `say`, which is a sentence the agent can use word for word.

| Tool | Arguments | Returns |
|---|---|---|
| `get_business_info` | none | name, trade, hours, service area, emergency policy, list of services (no prices) |
| `lookup_customer` | `phone` (optional; caller ID is used by default) | `found`, `name`, `address`, `last_job`, `upcoming_appointment` |
| `get_availability` | `date` (YYYY-MM-DD, optional), `limit` (optional, max 12) | `slots: [{ start (ISO), label }]` |
| `request_booking` | `customer_name`, `phone`, `address`, `service`, `slot_start` (ISO from `get_availability`), `notes`, `urgency` | `booking_id`, `status: "requested"`, `label` |
| `create_callback` | `customer_name`, `phone`, `reason`, `urgency` | `task_id` |

Free slots respect the owner's working hours, appointment length, existing jobs and the number of crew members.

### How each provider calls the tools

- **Retell (custom functions):** one URL per tool, `POST …/tools/<tool_name>`. The body is `{ name, args, call }`, or args only with "args at root". The response is the tool's JSON.
- **Vapi (server tools):** one URL for all tools, `POST …/tools`. The body is `message.type = "tool-calls"` with `toolCallList`. The response is `{ results: [{ toolCallId, result }] }`.
- **ElevenLabs (server tools / webhooks):** one URL per tool, `POST …/tools/<tool_name>`, with the arguments as the JSON body.
- **Generic:** `POST …/tools/<tool_name>` with the arguments as the body, or `POST …/tools` with `{ "name": "...", "args": { ... } }`.

### Suggested agent rules

- Always say you are an AI assistant, and that the call may be recorded.
- Never give a price. Say the owner will send a written quote.
- For emergencies (flooding, gas smell, no heat in winter, sparks), use `create_callback` with `urgency: "emergency"`. Give the safety advice from `emergency_policy`.
- Offer slots from `get_availability`. Use `request_booking` only after the caller agrees. Then say it will be confirmed by text or email.

## Adding a new provider

Add one adapter object in `lib/voice/adapters.js` with five methods:

```js
{
  id: 'newprovider', label: 'New Provider',
  verify(req, secret) {},             // true | false | null (no signature present)
  parseEvent(body) {},                // → { kind: 'call.completed', call: callRecord({...}) } or { kind: 'ignore' }
  parseToolCalls(body, toolFromPath) {}, // → [{ id, name, args, external_call_id, caller_phone }]
  formatToolResponse(results) {},     // → body the provider expects
}
```

No other file changes. The core only ever receives `callRecord(...)` from `lib/voice/contract.js`.
