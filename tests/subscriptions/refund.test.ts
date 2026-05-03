import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp, makeMockPrisma } from "../helpers/buildApp.js";

vi.mock("../../src/hooks/auth.js", () => ({
  authenticate: async () => {},
}));

const { cancelSubscription, refundPayment } = vi.hoisted(() => ({
  cancelSubscription: vi.fn(),
  refundPayment: vi.fn(),
}));
vi.mock("../../src/lib/razorpay.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../src/lib/razorpay.js")>(
      "../../src/lib/razorpay.js"
    );
  return { ...actual, cancelSubscription, refundPayment };
});

vi.mock("../../src/lib/email.js", () => ({
  sendRefundIssuedEmail: vi.fn(),
  sendRefundProcessedEmail: vi.fn(),
  sendRefundFailedSupportAlert: vi.fn(),
}));

import subscriptionRoutes from "../../src/routes/subscriptions/index.js";

const HOUR = 60 * 60 * 1000;

function activeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_db_1",
    userId: "user_test",
    razorpaySubscriptionId: "sub_rzp_1",
    planType: "MONTHLY" as const,
    status: "ACTIVE" as const,
    cancelledAt: null,
    refundedAt: null,
    refundId: null,
    refundStatus: null,
    refundAmount: null,
    firstPaymentId: "pay_rzp_1",
    firstPaymentAt: new Date(Date.now() - 2 * 24 * HOUR), // 2 days ago
    currentPeriodEnd: new Date(Date.now() + 28 * 24 * HOUR),
    ...overrides,
  };
}

describe("POST /subscriptions/refund", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("issues refund inside the 7-day window: refunds, cancels, flips isPremium", async () => {
    const prisma = makeMockPrisma(vi);
    prisma.subscription.findFirst.mockResolvedValue(activeSubscription());
    prisma.subscription.update.mockResolvedValue({});
    prisma.user.update.mockResolvedValue({});
    prisma.user.findUnique.mockResolvedValue({ email: "u@example.com" });
    refundPayment.mockResolvedValue({ id: "rfnd_1", status: "processing" });
    cancelSubscription.mockResolvedValue({});

    const app = await buildTestApp(
      { prisma, user: { userId: "user_test", role: "USER" } },
      async (a) => a.register(subscriptionRoutes)
    );

    const res = await app.inject({ method: "POST", url: "/refund" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      success: true,
      refundId: "rfnd_1",
      refundAmount: 349900,
      refundStatus: "processing",
    });

    expect(refundPayment).toHaveBeenCalledWith(
      "pay_rzp_1",
      349900,
      expect.objectContaining({ reason: "user_requested_7day_refund" })
    );
    expect(cancelSubscription).toHaveBeenCalledWith("sub_rzp_1", false);

    // Subscription update wrote refund fields + cancelledAt
    const subUpdate = prisma.subscription.update.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(subUpdate.data).toMatchObject({
      refundId: "rfnd_1",
      refundStatus: "processing",
      refundAmount: 349900,
    });
    expect(subUpdate.data.refundedAt).toBeInstanceOf(Date);
    expect(subUpdate.data.cancelledAt).toBeInstanceOf(Date);

    // isPremium flipped to false
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user_test" },
      data: { isPremium: false },
    });

    await app.close();
  });

  it("rejects refund outside the 7-day window with 400, doesn't call Razorpay", async () => {
    const prisma = makeMockPrisma(vi);
    prisma.subscription.findFirst.mockResolvedValue(
      activeSubscription({
        firstPaymentAt: new Date(Date.now() - 8 * 24 * HOUR), // 8 days ago
      })
    );

    const app = await buildTestApp(
      { prisma, user: { userId: "user_test", role: "USER" } },
      async (a) => a.register(subscriptionRoutes)
    );

    const res = await app.inject({ method: "POST", url: "/refund" });

    expect(res.statusCode).toBe(400);
    expect(refundPayment).not.toHaveBeenCalled();
    expect(prisma.subscription.update).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();

    await app.close();
  });

  it("rejects double-refund: returns 400 if refundedAt already set", async () => {
    const prisma = makeMockPrisma(vi);
    prisma.subscription.findFirst.mockResolvedValue(
      activeSubscription({ refundedAt: new Date() })
    );

    const app = await buildTestApp(
      { prisma, user: { userId: "user_test", role: "USER" } },
      async (a) => a.register(subscriptionRoutes)
    );

    const res = await app.inject({ method: "POST", url: "/refund" });

    expect(res.statusCode).toBe(400);
    expect(refundPayment).not.toHaveBeenCalled();

    await app.close();
  });

  it("if Razorpay refund throws, returns 502 and does NOT mutate DB or revoke premium", async () => {
    const prisma = makeMockPrisma(vi);
    prisma.subscription.findFirst.mockResolvedValue(activeSubscription());
    refundPayment.mockRejectedValue(new Error("Razorpay 500"));

    const app = await buildTestApp(
      { prisma, user: { userId: "user_test", role: "USER" } },
      async (a) => a.register(subscriptionRoutes)
    );

    const res = await app.inject({ method: "POST", url: "/refund" });

    expect(res.statusCode).toBe(502);
    expect(prisma.subscription.update).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(cancelSubscription).not.toHaveBeenCalled();

    await app.close();
  });

  it("rejects refund when subscription has no firstPaymentId (pre-feature sub)", async () => {
    const prisma = makeMockPrisma(vi);
    prisma.subscription.findFirst.mockResolvedValue(
      activeSubscription({ firstPaymentId: null, firstPaymentAt: null })
    );

    const app = await buildTestApp(
      { prisma, user: { userId: "user_test", role: "USER" } },
      async (a) => a.register(subscriptionRoutes)
    );

    const res = await app.inject({ method: "POST", url: "/refund" });

    expect(res.statusCode).toBe(400);
    expect(refundPayment).not.toHaveBeenCalled();

    await app.close();
  });
});
