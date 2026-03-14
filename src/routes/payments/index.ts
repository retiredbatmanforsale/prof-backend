import type { FastifyInstance } from "fastify";
import { authenticate } from "../../hooks/auth.js";
import { createOrder, verifyPaymentSignature } from "../../lib/razorpay.js";

export default async function paymentRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  // POST /payments/create-order
  app.post(
    "/create-order",
    {
      config: {
        rateLimit: { max: 5, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const userId = request.currentUser!.userId;

      const user = await app.prisma.user.findUnique({
        where: { id: userId },
        select: { isPremium: true },
      });

      if (user?.isPremium) {
        return reply
          .status(400)
          .send({ error: "You already have premium access" });
      }

      const membership = await app.prisma.organizationMember.findFirst({
        where: {
          userId,
          isActive: true,
          isVerified: true,
          organization: { isActive: true },
        },
      });

      if (membership) {
        return reply
          .status(400)
          .send({ error: "You already have access through your institution" });
      }

      const amount = parseInt(process.env.PLATFORM_PRICE || "49900", 10);
      const receipt = `rcpt_${userId.slice(-8)}_${Date.now()}`;

      const order = await createOrder(amount, "INR", receipt, { userId });

      await app.prisma.payment.create({
        data: {
          userId,
          razorpayOrderId: order.id,
          amount,
          status: "created",
          receipt,
        },
      });

      return reply.send({
        orderId: order.id,
        amount,
        currency: "INR",
        keyId: process.env.RAZORPAY_KEY_ID,
      });
    }
  );

  // POST /payments/verify
  app.post(
    "/verify",
    {
      config: {
        rateLimit: { max: 5, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const userId = request.currentUser!.userId;
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
        request.body as {
          razorpay_order_id: string;
          razorpay_payment_id: string;
          razorpay_signature: string;
        };

      const payment = await app.prisma.payment.findUnique({
        where: { razorpayOrderId: razorpay_order_id },
      });

      if (!payment || payment.userId !== userId) {
        return reply.status(404).send({ error: "Payment not found" });
      }

      if (payment.status === "paid") {
        return reply.send({
          success: true,
          message: "Payment already verified",
        });
      }

      const isValid = verifyPaymentSignature(
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature
      );

      if (!isValid) {
        return reply
          .status(400)
          .send({ error: "Payment verification failed" });
      }

      await app.prisma.$transaction([
        app.prisma.payment.update({
          where: { razorpayOrderId: razorpay_order_id },
          data: {
            status: "paid",
            razorpayPaymentId: razorpay_payment_id,
          },
        }),
        app.prisma.user.update({
          where: { id: userId },
          data: { isPremium: true },
        }),
      ]);

      return reply.send({
        success: true,
        message: "Payment verified and access granted",
      });
    }
  );

  // GET /payments/status
  app.get("/status", async (request, reply) => {
    const userId = request.currentUser!.userId;

    const user = await app.prisma.user.findUnique({
      where: { id: userId },
      select: { isPremium: true },
    });

    const membership = await app.prisma.organizationMember.findFirst({
      where: {
        userId,
        isActive: true,
        isVerified: true,
        organization: { isActive: true },
      },
      include: {
        organization: { select: { name: true } },
      },
    });

    const latestPayment = await app.prisma.payment.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { status: true, amount: true, createdAt: true },
    });

    const isPremium = user?.isPremium ?? false;
    const hasInstitution = !!membership;

    let accessType: "premium" | "institution" | null = null;
    if (isPremium) {
      accessType = "premium";
    } else if (hasInstitution) {
      accessType = "institution";
    }

    return reply.send({
      hasAccess: isPremium || hasInstitution,
      accessType,
      isPremium,
      organization: membership?.organization?.name ?? null,
      latestPayment: latestPayment ?? null,
    });
  });
}
