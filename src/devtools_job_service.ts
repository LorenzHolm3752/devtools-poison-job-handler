import { createServer, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { createInfraiQueue, InfraiError, type InfraiQueue } from "./infrai_queue.js";
import { buildJobSchema, decideFailure } from "./job_failure_policy.js";

const failureRequestSchema = z.object({
  message_id: z.string().min(1),
  payload: buildJobSchema
});

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

export async function handleFailedJob(
  queue: InfraiQueue,
  input: z.infer<typeof failureRequestSchema>
) {
  const decision = decideFailure(input.payload);
  const payload = decision.action === "retry" ? decision.next : decision.diagnostic;
  const operation = decision.action === "retry" ? "retry" : "dead-letter";

  await queue.publish(payload, `${operation}-${input.message_id}`);
  await queue.ack(input.message_id);
  return decision;
}

export async function runWorkerOnce(queue: InfraiQueue): Promise<void> {
  const messages = await queue.consume();
  for (const message of messages) {
    const payload = buildJobSchema.parse(message.payload);
    const decision = await handleFailedJob(queue, {
      message_id: message.message_id,
      payload
    });
    console.log(JSON.stringify({ message_id: message.message_id, decision }));
  }
}

function startDiagnosticService(queue: InfraiQueue): void {
  const port = Number(process.env.PORT ?? 3000);
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/failed-jobs") {
        sendJson(response, 404, { error: "Route not found" });
        return;
      }

      let raw = "";
      for await (const chunk of request) raw += chunk;
      const parsed = failureRequestSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        sendJson(response, 400, { error: "Invalid failed job", issues: parsed.error.issues });
        return;
      }

      try {
        const decision = await handleFailedJob(queue, parsed.data);
        sendJson(response, 202, decision);
      } catch (error) {
        if (error instanceof InfraiError) {
          const status = error.status >= 400 && error.status < 500 ? error.status : 502;
          sendJson(response, status, { error: error.code, message: error.message });
          return;
        }
        throw error;
      }
    })().catch((error: unknown) => {
      console.error(error);
      sendJson(response, 500, { error: "Failed to process job" });
    });
  });

  server.listen(port, () => console.log(`Developer diagnostics service listening on :${port}`));
}

async function main(): Promise<void> {
  const queue = createInfraiQueue();
  if (process.argv.includes("--once")) await runWorkerOnce(queue);
  else startDiagnosticService(queue);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
