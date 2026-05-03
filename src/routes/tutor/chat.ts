import { Readable } from "stream";
import type { FastifyInstance } from "fastify";
import Anthropic from "@anthropic-ai/sdk";
import { authenticate } from "../../hooks/auth.js";
import { tutorChatSchema } from "../../schemas/tutor.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;

function buildSystemPrompt(topic: string, concepts: string[]): string {
  return `You are a Socratic tutor for an AI/ML engineering course called Prof by Lex AI.

The learner has just studied: ${topic}
Key concepts covered in this lesson: ${concepts.join(", ")}

Your role is to test and deepen the learner's understanding through questioning — never through direct explanation.

Rules:
- NEVER explain a concept directly. Always respond with a question.
- If the learner's answer is incomplete or incorrect, do not correct them — ask a follow-up question that leads them to discover the flaw themselves.
- If the learner's answer is correct, go deeper and push to the edge of their understanding.
- Keep every response to 2-3 sentences maximum. This is a dialogue, not a lecture.
- After 6-8 exchanges, you may offer a brief 2-sentence synthesis of what the learner has demonstrated.
- Use precise ML/AI terminology naturally — never in a way that feels like teaching.
- If the user's first message is "Begin.", open the conversation immediately with your first Socratic question. Do not greet or introduce yourself.`;
}

export default async function tutorChatRoute(app: FastifyInstance) {
  app.post(
    "/chat",
    {
      preHandler: [authenticate],
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const parsed = tutorChatSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const { topic, concepts, message, history } = parsed.data;

      // Fail fast if the SDK can't authenticate — otherwise the error only
      // surfaces deep inside the stream loop and the user just sees "Stream
      // failed" with no actionable signal.
      if (!hasAnthropicKey) {
        app.log.error("ANTHROPIC_API_KEY is not set on this Cloud Run service");
        return reply.status(503).send({
          error: "Tutor is not configured. Please contact support.",
        });
      }

      // Use a Node.js Readable stream so Fastify manages the response
      // lifecycle. Headers chosen for HTTP/2 + Cloud Run's load balancer:
      //   - No `Connection: keep-alive` — that header is illegal on HTTP/2
      //     and gets stripped or rejected by some stacks.
      //   - `X-Accel-Buffering: no` — instructs nginx-style proxies not to
      //     buffer the response. Without it, SSE deltas can be held until
      //     the full response completes, which looks identical to a hang.
      const readable = new Readable({ read() {} });

      reply
        .header("Content-Type", "text/event-stream")
        .header("Cache-Control", "no-cache, no-transform")
        .header("X-Accel-Buffering", "no")
        .send(readable);

      const messages: Anthropic.MessageParam[] = [
        ...history.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
        { role: "user", content: message },
      ];

      try {
        const stream = client.messages.stream({
          model: "claude-haiku-4-5",
          max_tokens: 512,
          // System prompt is deterministic per (topic, concepts) and reused
          // across the 6–8 turn conversation, so mark it cacheable. Note:
          // Haiku 4.5's minimum cacheable prefix is 4096 tokens — at the
          // current ~250-token prompt this is a silent no-op, but it costs
          // nothing and activates automatically if the prompt ever grows
          // (e.g. if we add few-shot examples).
          system: [
            {
              type: "text",
              text: buildSystemPrompt(topic, concepts),
              cache_control: { type: "ephemeral" },
            },
          ],
          messages,
        });

        for await (const event of stream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            readable.push(
              `data: ${JSON.stringify({ text: event.delta.text })}\n\n`
            );
          }
        }

        readable.push("data: [DONE]\n\n");
      } catch (err) {
        // Log structured detail for Cloud Run, surface a useful message to
        // the client. Anthropic SDK errors carry .status and .message; other
        // errors fall back to a generic message but log the full object.
        const status =
          err && typeof err === "object" && "status" in err
            ? (err as { status?: number }).status
            : undefined;
        const message =
          err instanceof Error ? err.message : "Unknown stream error";
        app.log.error(
          { err, status, model: "claude-haiku-4-5" },
          "Tutor stream error"
        );
        readable.push(
          `data: ${JSON.stringify({
            error: status === 401 || status === 403
              ? "Tutor service authentication failed. Please contact support."
              : status === 429
                ? "Tutor is rate-limited right now. Please try again in a minute."
                : `Tutor failed: ${message}`,
            status,
          })}\n\n`
        );
      } finally {
        readable.push(null);
      }
    }
  );
}
