import { randomBytes } from "node:crypto";
import { RESET_PASSWORD_IDENTIFIER_PREFIX } from "./password-reset-links.js";

/** Minimal Better Auth mint contract, also implemented by a bound setup client. */
export interface VerificationValueWriter {
  createVerificationValue(data: {
    identifier: string;
    value: string;
    expiresAt: Date;
  }): Promise<unknown>;
}

export async function createSetPasswordToken(
  adapter: VerificationValueWriter,
  userId: string,
  expiresAt: Date,
): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await adapter.createVerificationValue({
    identifier: `${RESET_PASSWORD_IDENTIFIER_PREFIX}${token}`,
    value: userId,
    expiresAt,
  });
  return token;
}
