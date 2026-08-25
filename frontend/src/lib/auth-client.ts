import { createAuthClient } from "better-auth/react";

// Same-origin client: the Vite dev proxy forwards /api to the backend, so the
// baseURL stays empty and cookies flow naturally.
export const authClient = createAuthClient({
  baseURL: "",
  basePath: "/api/auth",
});
