import type { FastifyInstance } from "fastify";
import { verifyWebhookSignatureFn } from "../../lib/razorpay.js";

export default async function razorpayWebhookRoute(app: FastifyInstance) {
  // Override JSON parser to capture raw body for signature verification
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        const rawString = body as string;
        const json = JSON.parse(rawString);
        (json as any).__rawBody = rawString;
        done(null, json);
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );

  app.post("/razorpay", async (request, reply) => {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      app.log.error("RAZORPAY_WEBHOOK_SECRET not configured");
      return reply.status(500).send({ received: false });
    }

    const signature = request.headers["x-razorpay-signature"] as string;
    if (!signature) {
      return reply.status(400).send({ received: false });
    }

    const rawBody = (request.body as any).__rawBody as string | undefined;
    if (!rawBody) {
      return reply.status(400).send({ received: false });
    }

    let isValid: boolean;
    try {
      isValid = verifyWebhookSignatureFn(rawBody, signature, webhookSecret);
    } catch {
      return reply.status(400).send({ received: false });
    }

    if (!isValid) {
      return reply.status(400).send({ received: false });
    }

    const payload = request.body as {
      event?: string;
      payload?: {
        payment?: {
          entity?: {
            id?: string;
            order_id?: string;
            status?: string;
          };
        };
      };
    };

    const event = payload.event;
    const paymentEntity = payload.payload?.payment?.entity;

    if (!event || !paymentEntity) {
      return reply.send({ received: true });
    }

    if (event === "payment.captured") {
      const orderId = paymentEntity.order_id;
      const paymentId = paymentEntity.id;

      if (!orderId || !paymentId) {
        return reply.send({ received: true });
      }

      const payment = await app.prisma.payment.findUnique({
        where: { razorpayOrderId: orderId },
      });

      if (!payment || payment.status === "paid") {
        return reply.send({ received: true });
      }

      await app.prisma.$transaction([
        app.prisma.payment.update({
          where: { razorpayOrderId: orderId },
          data: {
            status: "paid",
            razorpayPaymentId: paymentId,
          },
        }),
        app.prisma.user.update({
          where: { id: payment.userId },
          data: { isPremium: true },
        }),
      ]);
    } else if (event === "payment.failed") {
      const orderId = paymentEntity.order_id;

      if (!orderId) {
        return reply.send({ received: true });
      }

      const payment = await app.prisma.payment.findUnique({
        where: { razorpayOrderId: orderId },
      });

      if (payment && payment.status !== "paid") {
        await app.prisma.payment.update({
          where: { razorpayOrderId: orderId },
          data: { status: "failed" },
        });
      }
    }

    return reply.send({ received: true });
  });
}
