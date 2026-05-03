import Fastify, { type FastifyInstance } from "fastify";
import type { Mock } from "vitest";

// Minimal mock of the Prisma client surface we touch. Tests fill in only the
// methods they need; everything is a vi.fn so calls can be asserted.
export interface MockPrisma {
  subscription: {
    findFirst: Mock;
    findUnique: Mock;
    findMany: Mock;
    update: Mock;
    create: Mock;
  };
  user: {
    findUnique: Mock;
    update: Mock;
  };
  payment: {
    findUnique: Mock;
    findFirst: Mock;
    update: Mock;
  };
  $transaction: Mock;
}

export function makeMockPrisma(vi: typeof import("vitest").vi): MockPrisma {
  return {
    subscription: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    payment: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    // Default $transaction: just resolve every entry.
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
  };
}

export interface BuildAppOpts {
  prisma: MockPrisma;
  // The "logged in" user. Set null to skip auth (tests for public routes).
  user?: { userId: string; email?: string; role?: "USER" | "ADMIN" } | null;
}

/**
 * Builds a Fastify instance with a fake auth hook + decorated mock prisma.
 * Caller passes in a register function that mounts the route under test.
 */
export async function buildTestApp(
  opts: BuildAppOpts,
  register: (app: FastifyInstance) => Promise<void>
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.decorate("prisma", opts.prisma as unknown as FastifyInstance["prisma"]);

  // Replace the real auth hook by stamping currentUser before any route runs.
  if (opts.user !== null) {
    const u = opts.user ?? { userId: "user_test", role: "USER" as const };
    app.addHook("onRequest", async (req) => {
      (req as unknown as { currentUser: typeof u }).currentUser = u;
    });
  }

  await register(app);
  await app.ready();
  return app;
}
