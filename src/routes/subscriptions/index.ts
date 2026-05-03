import type { FastifyInstance } from "fastify";
import type { PlanType } from "@prisma/client";
import { authenticate } from "../../hooks/auth.js";
import { getPlanConfig, getAllPlanConfigs } from "../../lib/plans.js";
import {
  createSubscription,
  cancelSubscription,
  createCustomer,
  verifySubscriptionSignature,
  refundPayment,
} from "../../lib/razorpay.js";

const REFUND_WINDOW_HOURS = 7 * 24;
const REFUND_WINDOW_MS = REFUND_WINDOW_HOURS * 60 * 60 * 1000;

function formatPrice(paise: number): string {
  const rupees = paise / 100;
  return "\u20B9" + rupees.toLocaleString("en-IN");
}

export default async function subscriptionRoutes(app: FastifyInstance) {
  // GET /subscriptions/plans — public, no auth
  app.get("/plans", {
    config: {
      rateLimit: { max: 30, timeWindow: "1 minute" },
    },
  }, async (_request, reply) => {
    const configs = getAllPlanConfigs();
    const plans = configs.map((c) => ({
      planType: c.planType,
      label: c.label,
      price: c.price,
      priceDisplay: formatPrice(c.price),
      interval: c.interval,
    }));
    return reply.send({ plans });
  });

  // POST /subscriptions/create
  app.post(
    "/create",
    {
      preHandler: [authenticate],
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
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          isPremium: true,
          razorpayCustomerId: true,
        },
      });

      if (!user) {
        return reply.status(404).send({ error: "User not found." });
      }

      if (user.isPremium) {
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

      // Cancel any stale CREATED subscriptions (user opened popup but never paid)
      const staleSubs = await app.prisma.subscription.findMany({
        where: { userId, status: "CREATED" },
      });

      for (const stale of staleSubs) {
        try {
          await cancelSubscription(stale.razorpaySubscriptionId, false);
        } catch {
          // Razorpay may have already cancelled it
        }
        await app.prisma.subscription.update({
          where: { id: stale.id },
          data: { status: "CANCELLED", cancelledAt: new Date() },
        });
      }

      // Check for existing active/pending subscription
      const existingSub = await app.prisma.subscription.findFirst({
        where: {
          userId,
          status: { in: ["AUTHENTICATED", "ACTIVE", "PENDING"] },
        },
      });

      if (existingSub) {
        return reply
          .status(400)
          .send({ error: "You already have an active or pending subscription." });
      }

      const plan = getPlanConfig(planType as PlanType);

      // Ensure user has a Razorpay customer record (reuse if exists, create if not)
      let customerId = user.razorpayCustomerId;
      if (!customerId) {
        try {
          const customer = await createCustomer(
            user.name,
            user.email,
            user.phone || undefined,
            { userId: user.id }
          );
          customerId = customer.id;
          await app.prisma.user.update({
            where: { id: user.id },
            data: { razorpayCustomerId: customerId },
          });
        } catch (err) {
          // Don't block subscription on customer creation failure — Razorpay
          // will still link to the user implicitly via email.
          app.log.warn(
            { userId: user.id, err },
            "Razorpay customer creation failed, continuing without customer_id"
          );
        }
      }

      const razorpaySub = await createSubscription(plan.razorpayPlanId, plan.totalCount, {
        customerId: customerId || undefined,
        customerNotify: 1,
        notifyEmail: user.email,
        notifyPhone: user.phone || undefined,
        notes: { userId, planType },
      });

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

      app.log.info(
        {
          userId,
          subscriptionId: razorpaySub.id,
          planType,
          customerId,
          notifyEmail: user.email,
          notifyPhone: user.phone || null,
        },
        "Subscription created"
      );

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
      preHandler: [authenticate],
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
            // Anchor the 7-day refund window to the first verified payment.
            // Only set if not already populated (idempotent across retries).
            ...(subscription.firstPaymentId
              ? {}
              : {
                  firstPaymentId: razorpay_payment_id,
                  firstPaymentAt: now,
                }),
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
  app.get("/status", {
    preHandler: [authenticate],
    config: {
      rateLimit: { max: 30, timeWindow: "1 minute" },
    },
  }, async (request, reply) => {
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
        firstPaymentAt: true,
        refundedAt: true,
        refundStatus: true,
        refundAmount: true,
      },
    });

    if (!subscription) {
      return reply.send({ subscription: null });
    }

    const refundEligibleUntil = subscription.firstPaymentAt
      ? new Date(subscription.firstPaymentAt.getTime() + REFUND_WINDOW_MS)
      : null;
    const isRefundEligible =
      !!refundEligibleUntil &&
      !subscription.refundedAt &&
      refundEligibleUntil.getTime() > Date.now() &&
      (subscription.status === "ACTIVE" ||
        subscription.status === "AUTHENTICATED");

    return reply.send({
      subscription: {
        planType: subscription.planType,
        status: subscription.status,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        cancelledAt: subscription.cancelledAt,
        createdAt: subscription.createdAt,
        refundedAt: subscription.refundedAt,
        refundStatus: subscription.refundStatus,
        refundAmount: subscription.refundAmount,
        isRefundEligible,
        refundEligibleUntil,
      },
    });
  });

  // POST /subscriptions/cancel-created — cleanup when user dismisses Razorpay popup
  app.post(
    "/cancel-created",
    {
      preHandler: [authenticate],
      config: {
        rateLimit: { max: 5, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const userId = request.currentUser!.userId;
      const { subscriptionId } = request.body as { subscriptionId: string };

      if (!subscriptionId) {
        return reply.status(400).send({ error: "Missing subscriptionId." });
      }

      const subscription = await app.prisma.subscription.findUnique({
        where: { razorpaySubscriptionId: subscriptionId },
      });

      if (!subscription || subscription.userId !== userId) {
        return reply.status(404).send({ error: "Subscription not found." });
      }

      if (subscription.status !== "CREATED") {
        return reply.send({ success: true, message: "Subscription is no longer in created state." });
      }

      try {
        await cancelSubscription(subscriptionId, false);
      } catch {
        // Razorpay may have already cancelled it
      }

      await app.prisma.subscription.update({
        where: { id: subscription.id },
        data: { status: "CANCELLED", cancelledAt: new Date() },
      });

      return reply.send({ success: true });
    }
  );

  // POST /subscriptions/cancel
  app.post(
    "/cancel",
    {
      preHandler: [authenticate],
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

  // POST /subscriptions/refund
  // 7-day refund window from firstPaymentAt. One refund per subscription.
  // On success: full refund issued, sub cancelled immediately, isPremium=false.
  app.post(
    "/refund",
    {
      preHandler: [authenticate],
      config: {
        rateLimit: { max: 3, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const userId = request.currentUser!.userId;

      const subscription = await app.prisma.subscription.findFirst({
        where: {
          userId,
          status: { in: ["ACTIVE", "AUTHENTICATED"] },
        },
        orderBy: { createdAt: "desc" },
      });

      if (!subscription) {
        return reply.status(404).send({ error: "No refundable subscription found." });
      }

      if (subscription.refundedAt) {
        return reply
          .status(400)
          .send({ error: "This subscription has already been refunded." });
      }

      if (!subscription.firstPaymentId || !subscription.firstPaymentAt) {
        // Should be impossible for a sub that reached ACTIVE/AUTHENTICATED
        // post-PR1, but guard anyway — pre-PR1 subs have no payment anchor.
        return reply.status(400).send({
          error:
            "Refund unavailable for this subscription. Please contact support.",
        });
      }

      const ageMs = Date.now() - subscription.firstPaymentAt.getTime();
      if (ageMs > REFUND_WINDOW_MS) {
        return reply.status(400).send({
          error: `Refund window has expired (7 days from first payment).`,
        });
      }

      const plan = getPlanConfig(subscription.planType);
      const refundAmount = plan.price;

      // Issue refund first. If this throws, we don't mutate local state —
      // user can retry. If it succeeds we MUST flip our state, otherwise
      // they keep premium with refunded money.
      let refund;
      try {
        refund = await refundPayment(subscription.firstPaymentId, refundAmount, {
          userId,
          subscriptionId: subscription.id,
          reason: "user_requested_7day_refund",
        });
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Refund request failed";
        app.log.error(
          {
            userId,
            subscriptionId: subscription.id,
            paymentId: subscription.firstPaymentId,
            err,
          },
          "Razorpay refund failed"
        );
        return reply.status(502).send({
          error: `Refund could not be processed: ${message}. Please contact support.`,
        });
      }

      // Best-effort: cancel the Razorpay subscription immediately so no
      // further auto-debit attempts. If this fails we still proceed —
      // refund is the user-visible commitment.
      try {
        await cancelSubscription(subscription.razorpaySubscriptionId, false);
      } catch (err) {
        app.log.warn(
          { subscriptionId: subscription.id, err },
          "Razorpay cancel-after-refund failed (refund still issued)"
        );
      }

      const now = new Date();
      await app.prisma.$transaction([
        app.prisma.subscription.update({
          where: { id: subscription.id },
          data: {
            refundId: refund.id,
            refundedAt: now,
            refundStatus: refund.status || "processing",
            refundAmount,
            cancelledAt: subscription.cancelledAt ?? now,
          },
        }),
        app.prisma.user.update({
          where: { id: userId },
          data: { isPremium: false },
        }),
      ]);

      app.log.info(
        {
          userId,
          subscriptionId: subscription.id,
          refundId: refund.id,
          amount: refundAmount,
          status: refund.status,
        },
        "Refund issued, premium revoked"
      );

      return reply.send({
        success: true,
        refundId: refund.id,
        refundAmount,
        refundStatus: refund.status || "processing",
        message:
          "Refund issued. Funds typically arrive in 5–7 business days. Your access has been revoked.",
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
