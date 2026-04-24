import { Readable } from "stream";
import type { FastifyInstance } from "fastify";
import Anthropic from "@anthropic-ai/sdk";
import { authenticate } from "../../hooks/auth.js";
import { tutorChatSchema } from "../../schemas/tutor.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

      // Use a Node.js Readable stream so Fastify manages the response lifecycle.
      // This is HTTP/2-compatible — the previous reply.hijack() + reply.raw.write()
      // approach silently drops the connection body on Cloud Run's HTTP/2 transport.
      const readable = new Readable({ read() {} });

      reply
        .header("Content-Type", "text/event-stream")
        .header("Cache-Control", "no-cache")
        .header("Connection", "keep-alive")
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
          model: "claude-opus-4-7",
          max_tokens: 512,
          system: buildSystemPrompt(topic, concepts),
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
        app.log.error(err, "Tutor stream error");
        readable.push(
          `data: ${JSON.stringify({ error: "Stream failed. Please try again." })}\n\n`
        );
      } finally {
        readable.push(null);
      }
    }
  );
}
