import type { Config } from "../config.js";

/**
 * OTP delivery stub. No real email/SMS integration exists or is needed at
 * this stage. Always logs a structured line; includes the raw code only
 * when `config.otpDevExpose` is on (NODE_ENV development or test, or
 * OTP_DEV_EXPOSE=true). It used to log it whenever NODE_ENV was not
 * 'production', which included an api started with NODE_ENV unset.
 */
/** Subset of the Fastify logger, so tests can pass a stub. */
export interface MinimalLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
}

export function sendOtpCode(
  logger: MinimalLogger,
  config: Pick<Config, "otpDevExpose">,
  recipient: { merchantUserId: string; email: string },
  code: string,
): void {
  if (!config.otpDevExpose) {
    logger.info({ merchantUserId: recipient.merchantUserId, channel: "otp" }, "otp code generated");
  } else {
    logger.info(
      { merchantUserId: recipient.merchantUserId, channel: "otp", code },
      "otp code generated (dev)",
    );
  }
}
