import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import { cancelSubscription } from "./razorpay.js";

export interface AdminCancelResult {
  cancelled: boolean;
  reason?: "no_active_subscription" | "already_cancelled" | "razorpay_failed";
  subscriptionId?: string;
  razorpaySubscriptionId?: string;
  error?: string;
}

// Cancel any active Razorpay subscription for a user, scheduled at cycle
// end so the period they've already paid for runs to completion (no
// future charges, no surprise mid-cycle refund obligation).
//
// We don't fail the caller if Razorpay errors — the caller's primary
// action (revoke premium, suspend account) is the user-visible
// commitment. The Razorpay cancel is best-effort, surfaced via the
// returned result so the caller can include a warning in its response.
export async function cancelActiveRazorpaySubscription(
  prisma: PrismaClient,
  userId: string,
  log?: FastifyBaseLogger
): Promise<AdminCancelResult> {
  const subscription = await prisma.subscription.findFirst({
    where: {
      userId,
      status: { in: ["AUTHENTICATED", "ACTIVE", "PENDING"] },
      refundedAt: null,
    },
    orderBy: { createdAt: "desc" },
  });

  if (!subscription) {
    return { cancelled: false, reason: "no_active_subscription" };
  }

  if (subscription.cancelledAt) {
    return {
      cancelled: false,
      reason: "already_cancelled",
      subscriptionId: subscription.id,
      razorpaySubscriptionId: subscription.razorpaySubscriptionId,
    };
  }

  try {
    await cancelSubscription(subscription.razorpaySubscriptionId, true);
  } catch (err) {
    log?.error(
      { userId, subscriptionId: subscription.id, err },
      "Razorpay cancel failed during admin action"
    );
    return {
      cancelled: false,
      reason: "razorpay_failed",
      subscriptionId: subscription.id,
      razorpaySubscriptionId: subscription.razorpaySubscriptionId,
      error: err instanceof Error ? err.message : "razorpay_error",
    };
  }

  await prisma.subscription.update({
    where: { id: subscription.id },
    data: { cancelledAt: new Date() },
  });

  return {
    cancelled: true,
    subscriptionId: subscription.id,
    razorpaySubscriptionId: subscription.razorpaySubscriptionId,
  };
}
