import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp, makeMockPrisma } from "../helpers/buildApp.js";

const { verifyWebhookSignatureFn } = vi.hoisted(() => ({
  verifyWebhookSignatureFn: vi.fn(),
}));
vi.mock("../../src/lib/razorpay.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../src/lib/razorpay.js")>(
      "../../src/lib/razorpay.js"
    );
  return { ...actual, verifyWebhookSignatureFn };
});

const { sendRefundProcessedEmail, sendRefundFailedSupportAlert } = vi.hoisted(
  () => ({
    sendRefundProcessedEmail: vi.fn(() => Promise.resolve()),
    sendRefundFailedSupportAlert: vi.fn(() => Promise.resolve()),
  })
);
vi.mock("../../src/lib/email.js", () => ({
  sendRefundProcessedEmail,
  sendRefundFailedSupportAlert,
  sendRefundIssuedEmail: vi.fn(),
}));

import razorpayWebhookRoute from "../../src/routes/webhooks/razorpay.js";

async function postWebhook(app: Awaited<ReturnType<typeof buildTestApp>>, body: unknown) {
  return app.inject({
    method: "POST",
    url: "/razorpay",
    headers: {
      "x-razorpay-signature": "fake_sig",
      "content-type": "application/json",
    },
    payload: JSON.stringify(body),
  });
}

describe("Razorpay refund webhooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyWebhookSignatureFn.mockReturnValue(true);
  });

  it("refund.processed: marks status=processed and emails the user", async () => {
    const prisma = makeMockPrisma(vi);
    prisma.subscription.findFirst.mockResolvedValue({
      id: "sub_db_1",
      userId: "user_test",
      refundAmount: 349900,
    });
    prisma.subscription.update.mockResolvedValue({});
    prisma.user.findUnique.mockResolvedValue({ email: "u@example.com" });

    const app = await buildTestApp({ prisma, user: null }, async (a) =>
      a.register(razorpayWebhookRoute)
    );

    const res = await postWebhook(app, {
      event: "refund.processed",
      payload: { refund: { entity: { id: "rfnd_1", payment_id: "pay_1", amount: 349900 } } },
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.subscription.update).toHaveBeenCalledWith({
      where: { id: "sub_db_1" },
      data: { refundStatus: "processed" },
    });
    // Email is fire-and-forget; allow microtask flush.
    await new Promise((r) => setImmediate(r));
    expect(sendRefundProcessedEmail).toHaveBeenCalledWith(
      "u@example.com",
      349900,
      "rfnd_1"
    );
    expect(sendRefundFailedSupportAlert).not.toHaveBeenCalled();

    await app.close();
  });

  it("refund.failed: marks failed, RE-grants premium, alerts support", async () => {
    const prisma = makeMockPrisma(vi);
    prisma.subscription.findFirst.mockResolvedValue({
      id: "sub_db_1",
      userId: "user_test",
      refundAmount: 349900,
    });
    prisma.subscription.update.mockResolvedValue({});
    prisma.user.update.mockResolvedValue({});
    prisma.user.findUnique.mockResolvedValue({ email: "u@example.com" });

    const app = await buildTestApp({ prisma, user: null }, async (a) =>
      a.register(razorpayWebhookRoute)
    );

    const res = await postWebhook(app, {
      event: "refund.failed",
      payload: { refund: { entity: { id: "rfnd_1", payment_id: "pay_1", amount: 349900 } } },
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user_test" },
      data: { isPremium: true },
    });
    await new Promise((r) => setImmediate(r));
    expect(sendRefundFailedSupportAlert).toHaveBeenCalledWith(
      "u@example.com",
      349900,
      "rfnd_1",
      "sub_db_1"
    );
    expect(sendRefundProcessedEmail).not.toHaveBeenCalled();

    await app.close();
  });

  it("rejects when signature fails", async () => {
    verifyWebhookSignatureFn.mockReturnValue(false);
    const prisma = makeMockPrisma(vi);
    const app = await buildTestApp({ prisma, user: null }, async (a) =>
      a.register(razorpayWebhookRoute)
    );

    const res = await postWebhook(app, {
      event: "refund.processed",
      payload: { refund: { entity: { id: "rfnd_x" } } },
    });

    expect(res.statusCode).toBe(400);
    expect(prisma.subscription.update).not.toHaveBeenCalled();

    await app.close();
  });

  it("ignores refund webhook for unknown subscription (no DB write)", async () => {
    const prisma = makeMockPrisma(vi);
    prisma.subscription.findFirst.mockResolvedValue(null);

    const app = await buildTestApp({ prisma, user: null }, async (a) =>
      a.register(razorpayWebhookRoute)
    );

    const res = await postWebhook(app, {
      event: "refund.processed",
      payload: { refund: { entity: { id: "rfnd_unknown", payment_id: "pay_x" } } },
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.subscription.update).not.toHaveBeenCalled();
    expect(sendRefundProcessedEmail).not.toHaveBeenCalled();

    await app.close();
  });
});
