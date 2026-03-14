import { buildApp } from "./app.js";

const PORT = parseInt(process.env.PORT || "4000", 10);
const HOST = process.env.HOST || "0.0.0.0";

async function start() {
  const app = await buildApp();

  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`Auth service running at http://${HOST}:${PORT}`);

    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.on(signal, () => {
        app.log.info(`${signal} received, shutting down...`);
        app.close().then(() => process.exit(0));
      });
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
