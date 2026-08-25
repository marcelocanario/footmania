import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    user?: { id: number; name: string; email: string; isAdmin: boolean; isPro: boolean };
    sessionToken?: string;
  }
}
