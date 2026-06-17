import { betterAuth } from "better-auth";
import { dash } from "@better-auth/infra";
import { D1Dialect } from "kysely-d1";
import type { Env } from "./index";

// Better Auth over D1 via the Kysely D1 dialect. Built per request — cheap, and
// keeps env out of module scope (Workers has no global env at import time).
// ponytail: per-request instance; memoize if auth shows up hot in profiling.
export function makeAuth(env: Env) {
  return betterAuth({
    database: { dialect: new D1Dialect({ database: env.DB }), type: "sqlite" },
    baseURL: env.BASE_URL,
    secret: env.AUTH_SECRET || "dev-secret-change-me",
    emailAndPassword: { enabled: true },
    socialProviders: env.GOOGLE_CLIENT_ID
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET || "",
          },
        }
      : undefined,
    plugins: [dash()],
  });
}

export async function currentUser(env: Env, req: Request) {
  try {
    const session = await makeAuth(env).api.getSession({ headers: req.headers });
    return session?.user ?? null;
  } catch {
    return null;
  }
}
