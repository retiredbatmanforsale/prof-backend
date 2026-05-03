import type { FastifyInstance } from "fastify";
import { waitlistSchema } from "../../schemas/auth.js";

export default async function waitlistRoute(app: FastifyInstance) {
  // POST /auth/waitlist — public, no auth. Captures pre-launch leads from
  // any surface (/experiences, /subscribe Memorandum gate, the dedicated
  // waitlist landing). Idempotent on email — re-submission updates the
  // row instead of erroring, and bumps lastSeenAt so we can prioritise
  // re-engaged visitors.
  app.post(
    "/waitlist",
    {
      // Generous rate limit — the form is public and visitors may retry
      // legitimately on slow networks. 10/min per IP keeps the spam floor
      // low without breaking honest UX.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const parsed = waitlistSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const data = parsed.data;
      const email = data.email.toLowerCase().trim();

      // Auto-capture the request context. Cloud Run sits behind a load
      // balancer; trust the standard X-Forwarded-For first hop, falling
      // back to socket address if the header is missing.
      const forwarded = request.headers["x-forwarded-for"];
      const ipAddress =
        (typeof forwarded === "string"
          ? forwarded.split(",")[0].trim()
          : Array.isArray(forwarded)
            ? forwarded[0]
            : null) ?? request.ip;
      const userAgent =
        typeof request.headers["user-agent"] === "string"
          ? request.headers["user-agent"].slice(0, 1024)
          : null;

      const now = new Date();

      try {
        const entry = await app.prisma.waitlistEntry.upsert({
          where: { email },
          create: {
            email,
            source: data.source,
            name: data.name,
            phone: data.phone,
            organization: data.organization,
            role: data.role,
            referrer: data.referrer?.slice(0, 512),
            utmSource: data.utmSource,
            utmMedium: data.utmMedium,
            utmCampaign: data.utmCampaign,
            ipAddress,
            userAgent,
            lastSeenAt: now,
          },
          update: {
            // Don't overwrite the original source — that's the
            // attribution channel. Bump lastSeenAt and fill in any
            // newly-supplied optional fields without erasing what we
            // already have.
            lastSeenAt: now,
            name: data.name ?? undefined,
            phone: data.phone ?? undefined,
            organization: data.organization ?? undefined,
            role: data.role ?? undefined,
            referrer: data.referrer?.slice(0, 512) ?? undefined,
            utmSource: data.utmSource ?? undefined,
            utmMedium: data.utmMedium ?? undefined,
            utmCampaign: data.utmCampaign ?? undefined,
            ipAddress: ipAddress ?? undefined,
            userAgent: userAgent ?? undefined,
          },
          select: {
            id: true,
            createdAt: true,
            lastSeenAt: true,
          },
        });

        // Don't reveal whether the email was new or returning — same
        // success shape for both cases keeps email enumeration off the
        // table and makes the frontend logic trivial.
        return reply.send({
          success: true,
          message: "You're on the list. We'll email you at launch.",
          id: entry.id,
        });
      } catch (err) {
        app.log.error({ err, email, source: data.source }, "Waitlist upsert failed");
        return reply.status(500).send({
          error: "Couldn't save your email right now. Please try again in a minute.",
        });
      }
    }
  );
}
