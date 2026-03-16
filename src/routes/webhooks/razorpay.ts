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
        subscription?: {
          entity?: {
            id?: string;
            plan_id?: string;
            status?: string;
            current_start?: number | null;
            current_end?: number | null;
            ended_at?: number | null;
          };
        };
      };
    };

    const event = payload.event;

    if (!event) {
      return reply.send({ received: true });
    }

    // ─── Payment events (existing) ─────────────────────────────
    if (event === "payment.captured") {
      const paymentEntity = payload.payload?.payment?.entity;
      const orderId = paymentEntity?.order_id;
      const paymentId = paymentEntity?.id;

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

      return reply.send({ received: true });
    }

    if (event === "payment.failed") {
      const paymentEntity = payload.payload?.payment?.entity;
      const orderId = paymentEntity?.order_id;

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

      return reply.send({ received: true });
    }

    // ─── Subscription events ───────────────────────────────────
    const subEntity = payload.payload?.subscription?.entity;
    if (!subEntity?.id) {
      return reply.send({ received: true });
    }

    const subscription = await app.prisma.subscription.findUnique({
      where: { razorpaySubscriptionId: subEntity.id },
    });

    if (!subscription) {
      app.log.warn(`Webhook received for unknown subscription: ${subEntity.id}`);
      return reply.send({ received: true });
    }

    const periodStart = subEntity.current_start
      ? new Date(subEntity.current_start * 1000)
      : subscription.currentPeriodStart;
    const periodEnd = subEntity.current_end
      ? new Date(subEntity.current_end * 1000)
      : subscription.currentPeriodEnd;

    switch (event) {
      case "subscription.activated": {
        await app.prisma.$transaction([
          app.prisma.subscription.update({
            where: { id: subscription.id },
            data: {
              status: "ACTIVE",
              currentPeriodStart: periodStart,
              currentPeriodEnd: periodEnd,
            },
          }),
          app.prisma.user.update({
            where: { id: subscription.userId },
            data: { isPremium: true },
          }),
        ]);
        break;
      }

      case "subscription.charged": {
        await app.prisma.$transaction([
          app.prisma.subscription.update({
            where: { id: subscription.id },
            data: {
              status: "ACTIVE",
              currentPeriodStart: periodStart,
              currentPeriodEnd: periodEnd,
            },
          }),
          app.prisma.user.update({
            where: { id: subscription.userId },
            data: { isPremium: true },
          }),
        ]);
        break;
      }

      case "subscription.pending": {
        await app.prisma.subscription.update({
          where: { id: subscription.id },
          data: { status: "PENDING" },
        });
        // Keep isPremium true — payment retry window
        break;
      }

      case "subscription.halted": {
        const keepPremium = await hasLegacyOneTimePayment(
          app.prisma,
          subscription.userId
        );
        await app.prisma.$transaction([
          app.prisma.subscription.update({
            where: { id: subscription.id },
            data: { status: "HALTED" },
          }),
          ...(keepPremium
            ? []
            : [
                app.prisma.user.update({
                  where: { id: subscription.userId },
                  data: { isPremium: false },
                }),
              ]),
        ]);
        break;
      }

      case "subscription.cancelled": {
        const keepPremium = await hasLegacyOneTimePayment(
          app.prisma,
          subscription.userId
        );
        await app.prisma.$transaction([
          app.prisma.subscription.update({
            where: { id: subscription.id },
            data: {
              status: "CANCELLED",
              cancelledAt: new Date(),
              endedAt: subEntity.ended_at
                ? new Date(subEntity.ended_at * 1000)
                : new Date(),
            },
          }),
          ...(keepPremium
            ? []
            : [
                app.prisma.user.update({
                  where: { id: subscription.userId },
                  data: { isPremium: false },
                }),
              ]),
        ]);
        break;
      }

      case "subscription.completed": {
        const keepPremium = await hasLegacyOneTimePayment(
          app.prisma,
          subscription.userId
        );
        await app.prisma.$transaction([
          app.prisma.subscription.update({
            where: { id: subscription.id },
            data: {
              status: "COMPLETED",
              endedAt: new Date(),
            },
          }),
          ...(keepPremium
            ? []
            : [
                app.prisma.user.update({
                  where: { id: subscription.userId },
                  data: { isPremium: false },
                }),
              ]),
        ]);
        break;
      }

      case "subscription.paused": {
        const keepPremium = await hasLegacyOneTimePayment(
          app.prisma,
          subscription.userId
        );
        await app.prisma.$transaction([
          app.prisma.subscription.update({
            where: { id: subscription.id },
            data: { status: "PAUSED" },
          }),
          ...(keepPremium
            ? []
            : [
                app.prisma.user.update({
                  where: { id: subscription.userId },
                  data: { isPremium: false },
                }),
              ]),
        ]);
        break;
      }

      case "subscription.resumed": {
        await app.prisma.$transaction([
          app.prisma.subscription.update({
            where: { id: subscription.id },
            data: {
              status: "ACTIVE",
              currentPeriodStart: periodStart,
              currentPeriodEnd: periodEnd,
            },
          }),
          app.prisma.user.update({
            where: { id: subscription.userId },
            data: { isPremium: true },
          }),
        ]);
        break;
      }

      default:
        app.log.info(`Unhandled webhook event: ${event}`);
    }

    return reply.send({ received: true });
  });
}

async function hasLegacyOneTimePayment(
  prisma: any,
  userId: string
): Promise<boolean> {
  const payment = await prisma.payment.findFirst({
    where: {
      userId,
      status: "paid",
    },
  });
  return !!payment;
}
