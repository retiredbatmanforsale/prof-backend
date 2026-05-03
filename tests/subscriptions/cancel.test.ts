import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp, makeMockPrisma } from "../helpers/buildApp.js";

// Mock the auth hook BEFORE the route module imports it. The route's
// preHandler becomes a no-op; the test app stamps currentUser in onRequest.
vi.mock("../../src/hooks/auth.js", () => ({
  authenticate: async () => {},
}));

// vi.hoisted lets us declare the spy alongside the mock factory (which is
// also hoisted) so the route module can capture the mocked export at import.
const { cancelSubscription, refundPayment } = vi.hoisted(() => ({
  cancelSubscription: vi.fn(),
  refundPayment: vi.fn(),
}));
vi.mock("../../src/lib/razorpay.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../src/lib/razorpay.js")>(
      "../../src/lib/razorpay.js"
    );
  return {
    ...actual,
    cancelSubscription,
    refundPayment,
  };
});

vi.mock("../../src/lib/email.js", () => ({
  sendRefundIssuedEmail: vi.fn(),
  sendRefundProcessedEmail: vi.fn(),
  sendRefundFailedSupportAlert: vi.fn(),
}));

import subscriptionRoutes from "../../src/routes/subscriptions/index.js";

describe("POST /subscriptions/cancel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("schedules cancel-at-cycle-end and stamps cancelledAt without flipping status", async () => {
    const prisma = makeMockPrisma(vi);
    prisma.subscription.findFirst.mockResolvedValue({
      id: "sub_db_1",
      userId: "user_test",
      razorpaySubscriptionId: "sub_rzp_1",
      status: "ACTIVE",
      currentPeriodEnd: new Date("2026-06-01"),
      cancelledAt: null,
    });
    prisma.subscription.update.mockResolvedValue({});
    cancelSubscription.mockResolvedValue({ status: "active", id: "sub_rzp_1" });

    const app = await buildTestApp(
      { prisma, user: { userId: "user_test", role: "USER" } },
      async (a) => a.register(subscriptionRoutes)
    );

    const res = await app.inject({
      method: "POST",
      url: "/cancel",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true });

    // Razorpay called with cancelAtCycleEnd=true
    expect(cancelSubscription).toHaveBeenCalledWith("sub_rzp_1", true);

    // DB only stamps cancelledAt — status stays ACTIVE until webhook fires
    const updateCall = prisma.subscription.update.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(updateCall.data).toHaveProperty("cancelledAt");
    expect(updateCall.data).not.toHaveProperty("status");

    await app.close();
  });

  it("returns 404 when no active subscription exists", async () => {
    const prisma = makeMockPrisma(vi);
    prisma.subscription.findFirst.mockResolvedValue(null);

    const app = await buildTestApp(
      { prisma, user: { userId: "user_test", role: "USER" } },
      async (a) => a.register(subscriptionRoutes)
    );

    const res = await app.inject({
      method: "POST",
      url: "/cancel",
    });

    expect(res.statusCode).toBe(404);
    expect(cancelSubscription).not.toHaveBeenCalled();

    await app.close();
  });
});
