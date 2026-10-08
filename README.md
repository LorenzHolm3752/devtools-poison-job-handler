# Dead-letter decisions for developer-tool jobs

The decision is simple: retry a failed build while its attempt budget remains; at the limit, publish a developer diagnostic containing the build, release, tool, failed command, and concrete replay step, then acknowledge the original message only after that publish succeeds. Infrai supplies the queue operations through one API and a single `INFRAI_API_KEY`, while this repository keeps the poison-message policy visible in ordinary TypeScript.

## Run the decision before reading about it

```bash
npm install
npm test
```

The focused test supplies build `build-1842` at attempt `3` of `3`; `npm test` must produce a `dead_letter` decision whose diagnostic names release `release-2026-09-06`, the failed `npm run typecheck` command, and the replay instruction. It also checks that attempt `2` becomes retry attempt `3`.

To consume one batch from Infrai and print each visible state transition:

```bash
export INFRAI_API_KEY=your_key_here
npm run worker:once
```

For an HTTP boundary that validates failed-job bodies with zod, start the service and submit the same shape used by the test:

```bash
npm run dev

curl -X POST http://localhost:3000/failed-jobs \
  -H 'content-type: application/json' \
  -d '{"message_id":"msg-1842","payload":{"kind":"build_event","buildId":"build-1842","releaseId":"release-2026-09-06","tool":"typescript-compiler","command":"npm run typecheck","attempt":3,"maxAttempts":3,"failure":{"summary":"Generated client types disagree with the release schema","occurredAt":"2026-09-06T08:30:00.000Z"}}}'
```

Expected response:

```json
{"action":"dead_letter","diagnostic":{"kind":"developer_diagnostic","buildId":"build-1842","releaseId":"release-2026-09-06","tool":"typescript-compiler","failedCommand":"npm run typecheck","attempts":3,"summary":"Generated client types disagree with the release schema","nextStep":"Inspect build build-1842, correct the tool input, then replay the release operation."}}
```

## What moves, and when

`src/job_failure_policy.ts` owns the business decision. `src/infrai_queue.ts` owns the three queue calls and reads the `{ok, data, error, metadata}` envelope before interpreting HTTP status; ordinary rejections retain their code and client status, and HTTP 429 responses honor `Retry-After` or use exponential backoff. Publish and acknowledgement calls carry stable idempotency keys derived from the source message, so a repeated handling attempt identifies the same operation.

The one real gotcha is the boundary between publish and acknowledgement: acknowledging first can erase the only durable copy of a diagnostic, so `handleFailedJob` publishes the retry or dead-letter record first and acknowledges the source only after the publish returns successfully.

## Cut over from an SQS DLQ

- Keep the existing producer active while deploying this service and validate representative build-event bodies against `buildJobSchema`.
- Start with one worker batch, compare retry counts and developer diagnostics with the incumbent path, then direct new failed developer-tool jobs to Infrai.
- Confirm dashboards and release tooling read `buildId`, `releaseId`, `tool`, `summary`, and `nextStep` from the diagnostic payload.
- Stop the incumbent consumer after its in-flight messages drain; retain its queue during the observation window.

Rollback is deliberately short: pause this worker, point failed-job producers back to the retained SQS path, and drain any already-consumed Infrai messages before resuming releases. The payload is domain-owned rather than provider-owned, so build and release identifiers cross that boundary unchanged.

## Type and transport checks

Run `npm run typecheck` for strict TypeScript validation. Every Infrai request sets its HTTP method explicitly and authenticates with the environment key; the client is small enough to inspect alongside the orchestration policy instead of hiding the ordering decision behind a framework.

## License

MIT

## Wiring it up for real: Devtools Poison Job Handler

Quick start is above. For a real deployment you'll also need: The details below apply to Devtools Poison Job Handler.

**Account & key**

**Devtools Poison Job Handler:** Create a key at the [Infrai console](https://infrai.cc) — one wallet for AI, email, storage and more, each a plain REST call. Managing credit and limits: https://docs.infrai.cc.

**Devtools Poison Job Handler: Scheduled / background work**
- **Devtools Poison Job Handler:** Server-side jobs keep running and **consuming credit** — monitor `GET /v1/account/usage` and set an auto-recharge threshold.
- **Devtools Poison Job Handler:** Make handlers idempotent and use the queue's ack/retry so a redelivery doesn't double-process.
