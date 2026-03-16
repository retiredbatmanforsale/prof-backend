import type { FastifyInstance } from "fastify";
import type { PlanType } from "@prisma/client";
import { authenticate } from "../../hooks/auth.js";
import { getPlanConfig } from "../../lib/plans.js";
import {
  createSubscription,
  cancelSubscription,
  verifySubscriptionSignature,
} from "../../lib/razorpay.js";

export default async function subscriptionRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  // POST /subscriptions/create
  app.post(
    "/create",
    {
      config: {
        rateLimit: { max: 5, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const userId = request.currentUser!.userId;
      const { planType } = request.body as { planType: string };

      if (!planType || !["MONTHLY", "QUARTERLY", "YEARLY"].includes(planType)) {
        return reply
          .status(400)
          .send({ error: "Invalid planType. Must be MONTHLY, QUARTERLY, or YEARLY." });
      }

      // Check if user already has access
      const user = await app.prisma.user.findUnique({
        where: { id: userId },
        select: { isPremium: true, email: true },
      });

      if (user?.isPremium) {
        return reply
          .status(400)
          .send({ error: "You already have active access." });
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
          .send({ error: "You already have access through your institution." });
      }

      // Check for existing active/pending subscription
      const existingSub = await app.prisma.subscription.findFirst({
        where: {
          userId,
          status: { in: ["CREATED", "AUTHENTICATED", "ACTIVE", "PENDING"] },
        },
      });

      if (existingSub) {
        return reply
          .status(400)
          .send({ error: "You already have an active or pending subscription." });
      }

      const plan = getPlanConfig(planType as PlanType);

      const razorpaySub = await createSubscription(
        plan.razorpayPlanId,
        plan.totalCount,
        { userId, planType }
      );

      await app.prisma.subscription.create({
        data: {
          userId,
          razorpaySubscriptionId: razorpaySub.id,
          razorpayPlanId: plan.razorpayPlanId,
          planType: planType as PlanType,
          status: "CREATED",
          shortUrl: razorpaySub.short_url || null,
        },
      });

      return reply.send({
        subscriptionId: razorpaySub.id,
        keyId: process.env.RAZORPAY_KEY_ID,
      });
    }
  );

  // POST /subscriptions/verify
  app.post(
    "/verify",
    {
      config: {
        rateLimit: { max: 5, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const userId = request.currentUser!.userId;
      const {
        razorpay_subscription_id,
        razorpay_payment_id,
        razorpay_signature,
      } = request.body as {
        razorpay_subscription_id: string;
        razorpay_payment_id: string;
        razorpay_signature: string;
      };

      if (!razorpay_subscription_id || !razorpay_payment_id || !razorpay_signature) {
        return reply
          .status(400)
          .send({ error: "Missing required payment verification fields." });
      }

      const subscription = await app.prisma.subscription.findUnique({
        where: { razorpaySubscriptionId: razorpay_subscription_id },
      });

      if (!subscription || subscription.userId !== userId) {
        return reply.status(404).send({ error: "Subscription not found." });
      }

      if (subscription.status === "ACTIVE") {
        return reply.send({
          success: true,
          message: "Subscription already verified.",
        });
      }

      const isValid = verifySubscriptionSignature(
        razorpay_subscription_id,
        razorpay_payment_id,
        razorpay_signature
      );

      if (!isValid) {
        return reply
          .status(400)
          .send({ error: "Subscription verification failed." });
      }

      // Calculate currentPeriodEnd based on plan type
      const now = new Date();
      const periodEnd = calculatePeriodEnd(now, subscription.planType);

      await app.prisma.$transaction([
        app.prisma.subscription.update({
          where: { razorpaySubscriptionId: razorpay_subscription_id },
          data: {
            status: "AUTHENTICATED",
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
          },
        }),
        app.prisma.user.update({
          where: { id: userId },
          data: { isPremium: true },
        }),
      ]);

      return reply.send({
        success: true,
        message: "Subscription verified and access granted.",
      });
    }
  );

  // GET /subscriptions/status
  app.get("/status", async (request, reply) => {
    const userId = request.currentUser!.userId;

    const subscription = await app.prisma.subscription.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: {
        planType: true,
        status: true,
        currentPeriodStart: true,
        currentPeriodEnd: true,
        cancelledAt: true,
        createdAt: true,
      },
    });

    if (!subscription) {
      return reply.send({ subscription: null });
    }

    return reply.send({
      subscription: {
        planType: subscription.planType,
        status: subscription.status,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        cancelledAt: subscription.cancelledAt,
        createdAt: subscription.createdAt,
      },
    });
  });

  // POST /subscriptions/cancel
  app.post(
    "/cancel",
    {
      config: {
        rateLimit: { max: 3, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const userId = request.currentUser!.userId;

      const subscription = await app.prisma.subscription.findFirst({
        where: {
          userId,
          status: { in: ["ACTIVE", "AUTHENTICATED", "PENDING"] },
        },
        orderBy: { createdAt: "desc" },
      });

      if (!subscription) {
        return reply
          .status(404)
          .send({ error: "No active subscription found." });
      }

      await cancelSubscription(subscription.razorpaySubscriptionId, true);

      await app.prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          cancelledAt: new Date(),
        },
      });

      return reply.send({
        success: true,
        message: "Subscription will be cancelled at the end of the current billing period.",
        currentPeriodEnd: subscription.currentPeriodEnd,
      });
    }
  );
}

function calculatePeriodEnd(start: Date, planType: PlanType): Date {
  const end = new Date(start);
  switch (planType) {
    case "MONTHLY":
      end.setMonth(end.getMonth() + 1);
      break;
    case "QUARTERLY":
      end.setMonth(end.getMonth() + 3);
      break;
    case "YEARLY":
      end.setFullYear(end.getFullYear() + 1);
      break;
  }
  return end;
}
