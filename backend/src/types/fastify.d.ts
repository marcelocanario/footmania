import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    user?: { id: number; username: string };
    sessionToken?: string;
  }
}
