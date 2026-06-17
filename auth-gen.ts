// Generation-only config for `@better-auth/cli generate`. Mirrors worker/auth.ts
// plugins so the CLI can emit the dash + sentinel tables. The dialect is a stub
// because `generate` only reads plugin schemas, it never connects. Not shipped.
import { betterAuth } from "better-auth";
import { dash, sentinel } from "@better-auth/infra";

export const auth = betterAuth({
  database: { dialect: {} as any, type: "sqlite" },
  emailAndPassword: { enabled: true },
  plugins: [dash(), sentinel()],
});
