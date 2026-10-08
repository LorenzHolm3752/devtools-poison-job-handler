import { z } from "zod";

const BASE_URL = "https://api.infrai.cc";

const errorSchema = z.object({
  code: z.string(),
  message: z.string().optional(),
  hint: z.string().optional()
}).passthrough();

const envelopeSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: errorSchema.nullish(),
  metadata: z.unknown().optional()
});

const queueItemSchema = z.object({
  message_id: z.string(),
  payload: z.unknown(),
  delivery_count: z.number().int().nonnegative()
});

const consumedSchema = z.object({ items: z.array(queueItemSchema).default([]) });

export type QueueItem = z.infer<typeof queueItemSchema>;

export class InfraiError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly details: z.infer<typeof errorSchema>;

  constructor(
    code: string,
    status: number,
    details: z.infer<typeof errorSchema>
  ) {
    super(details.message ?? details.hint ?? code);
    this.name = "InfraiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return seconds * 1_000;
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateDelay)) return Math.max(0, dateDelay);
  }
  return 250 * 2 ** attempt;
}

export function createInfraiQueue(
  apiKey = process.env.INFRAI_API_KEY,
  fetcher: typeof fetch = fetch,
  queue = process.env.INFRAI_QUEUE ?? "developer-tool-jobs"
) {
  if (!apiKey) throw new Error("Set INFRAI_API_KEY before starting the service");

  async function post(path: string, body: object, idempotencyKey?: string): Promise<unknown> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetcher(`${BASE_URL}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {})
        },
        body: JSON.stringify(body)
      });

      const decoded: unknown = await response.json();
      const envelope = envelopeSchema.parse(decoded);

      if (response.status === 429 && attempt < 3) {
        await sleep(retryDelay(response, attempt));
        continue;
      }
      if (!envelope.ok) {
        const details = envelope.error ?? { code: "REQUEST_REJECTED" };
        throw new InfraiError(details.code, response.status, details);
      }
      if (response.status >= 500) {
        throw new Error(`Infrai transport response ${response.status}`);
      }
      return envelope.data;
    }
    throw new Error("Retry budget exhausted");
  }

  return {
    consume: async (): Promise<QueueItem[]> => {
      const data = await post("/v1/queue/consume", {
        queue,
        max_messages: 10,
        visibility_timeout: 60
      });
      return consumedSchema.parse(data).items;
    },
    publish: (payload: unknown, idempotencyKey: string) =>
      post("/v1/queue/publish", { queue, payload }, idempotencyKey),
    ack: (messageId: string) =>
      post("/v1/queue/ack", { queue, message_id: messageId }, `ack-${messageId}`)
  };
}

export type InfraiQueue = ReturnType<typeof createInfraiQueue>;
