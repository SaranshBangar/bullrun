import { betterAuth } from "better-auth";
import { dash, sentinel } from "@better-auth/infra";
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
    // Better Auth Infra: dash (admin dashboard + analytics) and sentinel (bot /
    // abuse protection). Both are backed by the Infra cloud API — pass the key
    // when set; without it they degrade gracefully (sentinel → allow mode) and
    // never block sign-in. The CLI confirms neither adds local D1 tables.
    plugins: [
      dash(env.BETTER_AUTH_API_KEY ? { apiKey: env.BETTER_AUTH_API_KEY } : undefined),
      sentinel(env.BETTER_AUTH_API_KEY ? { apiKey: env.BETTER_AUTH_API_KEY } : undefined),
    ],
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
