import "./dotenv.js";

import Fastify from "fastify";
import FastifyCors from "@fastify/cors";
import FastifyMultipart from "@fastify/multipart";
import { stealthWorkers } from "./src/workers/stealthWorkers.js";
import { authRoutes } from './src/routes/authRoutes.js';
import { userRoutes } from "./src/routes/userRoutes.js";
import { addressRoutes } from "./src/routes/addressRoutes.js";
import { linkRoutes } from "./src/routes/linkRoutes.js";
import { stealthListener } from "./src/workers/stealthListener.js";
import { cctpRoutes } from "./src/routes/cctpRoutes.js";

console.log(
  "======================\n======================\nMY BACKEND SYSTEM STARTED!\n======================\n======================\n"
);

const fastify = Fastify({
  logger: false,
});

fastify.register(FastifyMultipart, {
  limits: {
    fieldNameSize: 100, // Max field name size in bytes
    fieldSize: 100000, // Max field value size in bytes
    fields: 10,        // Max number of non-file fields
    fileSize: 5 * 1024 * 1024, // 5MB limit
    files: 1,         // Max number of file fields
  },
  attachFieldsToBody: true, // Attach fields to request.body
});

fastify.register(FastifyCors, {
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization", 'token'],
});

fastify.get("/", async (request, reply) => {
  return reply.status(200).send({
    message: "Hello there!",
    error: null,
    data: null,
  });
});

/* --------------------------------- Routes --------------------------------- */
fastify.register(authRoutes, {
  prefix: '/auth'
})

fastify.register(userRoutes, {
  prefix: '/user'
})

fastify.register(addressRoutes, {
  prefix: '/address'
})

fastify.register(linkRoutes, {
  prefix: '/link'
})

fastify.register(cctpRoutes, {
  prefix: '/cctp'
})

/* --------------------------------- Workers -------------------------------- */
fastify.register(stealthWorkers)

const start = async () => {
  try {
    const port = process.env.APP_PORT || 3700;
    await fastify.listen({
      port: port,
      host: "0.0.0.0",
    });

    console.log(
      `Server started successfully on port ${fastify.server.address().port}`
    );
    console.log(`http://localhost:${fastify.server.address().port}`);
  } catch (error) {
    console.log("Error starting server: ", error);
    process.exit(1);
  }
};

start();