import type { FastifyInstance } from "fastify";

export default async function refundRoutes(app: FastifyInstance) {
  // GET /admin/refunds — list recent refunds for support visibility.
  // Auth + admin guard are already applied at the parent (admin/index.ts).
  app.get(
    "/refunds",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { limit = "50" } = request.query as { limit?: string };
      const take = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

      const refunds = await app.prisma.subscription.findMany({
        where: { refundedAt: { not: null } },
        orderBy: { refundedAt: "desc" },
        take,
        select: {
          id: true,
          userId: true,
          razorpaySubscriptionId: true,
          planType: true,
          refundId: true,
          refundedAt: true,
          refundStatus: true,
          refundAmount: true,
          firstPaymentId: true,
          firstPaymentAt: true,
          createdAt: true,
          user: { select: { email: true, name: true } },
        },
      });

      return reply.send({
        refunds: refunds.map((r) => ({
          subscriptionId: r.id,
          userId: r.userId,
          userEmail: r.user.email,
          userName: r.user.name,
          razorpaySubscriptionId: r.razorpaySubscriptionId,
          planType: r.planType,
          refundId: r.refundId,
          refundedAt: r.refundedAt,
          refundStatus: r.refundStatus,
          refundAmount: r.refundAmount,
          firstPaymentId: r.firstPaymentId,
          firstPaymentAt: r.firstPaymentAt,
          subscriptionStartedAt: r.createdAt,
        })),
      });
    }
  );
}
