import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { verifyPassword } from "../adminAuth/passwords.js";
import { issueAdminChallenge, verifyOtpCode } from "../adminAuth/otp.js";
import { sendAdminOtpCode } from "../adminAuth/notifier.js";
import { requireAdminSession } from "../adminAuth/middleware.js";
import {
  createPendingAdminSession,
  lookupPendingAdminSession,
  promoteAdminSession,
  revokeAdminSession,
  type AdminRole,
} from "../adminAuth/sessions.js";
import { reserveLoginAttempt, resetLoginAttempts } from "../auth/loginLockout.js";
import { withTransaction } from "../db/withTransaction.js";
import { BadRequestError, GoneError, TooManyRequestsError, UnauthorizedError } from "../lib/errors.js";

/**
 * A pre-computed argon2id hash of a fixed, never-used dummy password, at the
 * same cost parameters this app defaults to. Verified against on every login
 * attempt for an email that doesn't resolve to an active admin, so a failed
 * lookup and a failed password check take comparable time.
 */
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,p=1,t=2$/yKuaUqm4SW+pPt2oGNj4A$j5oxu/MdJJP86dClo0LJ0wsekKwkSbr1yA0uZSZgQcc";

interface LoginBody {
  email?: string;
  password?: string;
}

interface OtpVerifyBody {
  code?: string;
}

/** status 'disabled' blocks login and kills existing sessions (requireAdminSession re-reads it). */
interface AdminUserRow {
  id: string;
  email: string;
  role: AdminRole;
  password_hash: string;
}

/**
 * Registered with prefix '/v1/admin/auth'. Structurally identical to the
 * merchant login (password -> OTP -> authenticated session), with one
 * simplification the schema makes possible: `admin_users.email` is globally
 * unique, so unlike merchant login there is no tenant id to disambiguate
 * with — the lookup is unambiguous by construction.
 *
 * Admin login requires OTP deliberately: this is the plane where the most
 * dangerous operations live, so it must not have a weaker login factor than
 * an ordinary merchant dashboard user.
 */
export async function adminAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: LoginBody }>("/login", async (request, reply) => {
    const { email, password } = request.body ?? {};
    if (!email || !password) {
      throw new BadRequestError("invalid_request", "email and password are required");
    }

    const userResult = await app.db.query<AdminUserRow>(
      `SELECT id, email, role, password_hash FROM admin_users WHERE email = $1 AND status = 'active'`,
      [email],
    );
    const user = userResult.rows[0];

    // Brute-force lockout: reserve the attempt before checking the password.
    const allowed = user
      ? await reserveLoginAttempt(app.db, "admin_users", user.id, {
          maxAttempts: app.config.loginMaxFailedAttempts,
          lockoutMinutes: app.config.loginLockoutMinutes,
        })
      : false;

    const passwordOk = await verifyPassword(user && allowed ? user.password_hash : DUMMY_PASSWORD_HASH, password);

    // The same generic error in every failure case (no row, disabled or
    // locked account, or wrong password) — the response never discloses which.
    if (!user || !allowed || !passwordOk) {
      throw new UnauthorizedError("invalid_credentials");
    }
    await resetLoginAttempts(app.db, "admin_users", user.id);

    const { code, expiresAt, rawToken } = await withTransaction(app.db, async (client) => {
      const challenge = await issueAdminChallenge(client, {
        adminUserId: user.id,
        ttlMinutes: app.config.adminOtpTtlMinutes,
        codeLength: app.config.adminOtpCodeLength,
        maxAttempts: app.config.adminOtpMaxAttempts,
      });
      const session = await createPendingAdminSession(client, {
        adminUserId: user.id,
        otpChallengeId: challenge.id,
        ttlMinutes: app.config.adminPendingSessionTtlMinutes,
        ipAddress: request.ip,
        userAgent: (request.headers["user-agent"] as string | undefined) ?? null,
      });
      return { code: challenge.code, expiresAt: challenge.expiresAt, rawToken: session.rawToken };
    });

    sendAdminOtpCode(request.log, app.config, { adminUserId: user.id, email: user.email }, code);

    reply.setCookie(app.config.adminCookieName, rawToken, {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: app.config.cookieSecure,
      maxAge: app.config.adminPendingSessionTtlMinutes * 60,
    });

    const responseBody: Record<string, unknown> = {
      otpRequired: true,
      otpExpiresAt: expiresAt.toISOString(),
    };
    if (app.config.otpDevExpose) {
      responseBody.devOtpCode = code;
    }
    reply.code(200).send(responseBody);
  });

  app.post<{ Body: OtpVerifyBody }>("/otp/verify", async (request, reply) => {
    const code = request.body?.code;
    if (!code) {
      throw new BadRequestError("invalid_request", "code is required");
    }

    const rawToken = request.cookies[app.config.adminCookieName];
    if (!rawToken) {
      throw new UnauthorizedError("no_pending_session");
    }
    const pending = await lookupPendingAdminSession(app.db, rawToken);
    if (!pending || !pending.otpChallengeId) {
      throw new UnauthorizedError("no_pending_session");
    }

    // Reserve an attempt atomically BEFORE comparing the code: a single
    // conditional UPDATE, so N parallel guesses can never all observe
    // attempt_count < max_attempts (the old check-then-increment let every
    // concurrent request through).
    const reserved = await app.db.query<{ id: string; code_salt: string; code_hash: string }>(
      `UPDATE admin_otp_challenges
          SET attempt_count = attempt_count + 1
        WHERE id = $1
          AND consumed_at IS NULL
          AND expires_at > now()
          AND attempt_count < max_attempts
      RETURNING id, code_salt, code_hash`,
      [pending.otpChallengeId],
    );
    const challenge = reserved.rows[0];
    if (!challenge) {
      const state = await app.db.query<{ consumed_at: Date | null; expires_at: Date }>(
        `SELECT consumed_at, expires_at FROM admin_otp_challenges WHERE id = $1`,
        [pending.otpChallengeId],
      );
      const row = state.rows[0];
      if (!row || row.consumed_at !== null || row.expires_at.getTime() <= Date.now()) {
        throw new GoneError("otp_expired");
      }
      await revokeAdminSession(app.db, pending.adminSessionId);
      throw new TooManyRequestsError("too_many_attempts");
    }

    const matches = verifyOtpCode(code, challenge.code_salt, challenge.code_hash);
    if (!matches) {
      throw new UnauthorizedError("invalid_code");
    }

    const { adminUser, sessionToken } = await withTransaction(app.db, async (client) => {
      const consumed = await client.query(
        `UPDATE admin_otp_challenges SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL`,
        [challenge.id],
      );
      if ((consumed.rowCount ?? 0) === 0) {
        throw new GoneError("otp_expired");
      }
      const promoted = await promoteAdminSession(client, pending.adminSessionId, app.config.adminSessionTtlHours);
      const result = await client.query<{ role: AdminRole }>(
        `SELECT role FROM admin_users WHERE id = $1`,
        [pending.adminUserId],
      );
      return { adminUser: result.rows[0], sessionToken: promoted.rawToken };
    });
    if (!adminUser) {
      throw new Error("admin otp/verify: admin_users row disappeared mid-transaction");
    }

    // Set the ROTATED token (promoteAdminSession replaced the pre-OTP one, so
    // the pending cookie is dead from here on — no session fixation), with
    // the full session TTL rather than the short pending window.
    reply.setCookie(app.config.adminCookieName, sessionToken, {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: app.config.cookieSecure,
      maxAge: app.config.adminSessionTtlHours * 3_600,
    });

    reply.code(200).send({
      authenticated: true,
      adminUserId: pending.adminUserId,
      role: adminUser.role,
    });
  });

  /**
   * Re-issues the OTP for a pending admin session. Mirrors the merchant
   * /v1/auth/otp/resend exactly: throttled to one per 30 s, the previous
   * challenge is consumed, and the new challenge inherits its attempt_count
   * so a resend never resets the guess budget.
   */
  app.post("/otp/resend", async (request: FastifyRequest, reply: FastifyReply) => {
    const rawToken = request.cookies[app.config.adminCookieName];
    if (!rawToken) {
      throw new UnauthorizedError("no_pending_session");
    }
    const pending = await lookupPendingAdminSession(app.db, rawToken);
    if (!pending || !pending.otpChallengeId) {
      throw new UnauthorizedError("no_pending_session");
    }

    const { code, expiresAt } = await withTransaction(app.db, async (client) => {
      // Read the current challenge under a row lock, inside the transaction,
      // so parallel resends cannot all pass the throttle (same as merchant).
      const existing = await client.query<{ id: string; created_at: Date; attempt_count: number; consumed_at: Date | null }>(
        `SELECT id, created_at, attempt_count, consumed_at FROM admin_otp_challenges WHERE id = $1 FOR UPDATE`,
        [pending.otpChallengeId],
      );
      const existingChallenge = existing.rows[0];
      if (existingChallenge) {
        if (existingChallenge.consumed_at !== null || Date.now() - existingChallenge.created_at.getTime() < 30_000) {
          throw new TooManyRequestsError("resend_too_soon");
        }
        await client.query(`UPDATE admin_otp_challenges SET consumed_at = now() WHERE id = $1`, [
          existingChallenge.id,
        ]);
      }
      const challenge = await issueAdminChallenge(client, {
        adminUserId: pending.adminUserId,
        ttlMinutes: app.config.adminOtpTtlMinutes,
        codeLength: app.config.adminOtpCodeLength,
        maxAttempts: app.config.adminOtpMaxAttempts,
      });
      // Carry the guess count over so resend never resets the lockout budget.
      if (existingChallenge) {
        await client.query(`UPDATE admin_otp_challenges SET attempt_count = $2 WHERE id = $1`, [
          challenge.id,
          existingChallenge.attempt_count,
        ]);
      }
      await client.query(`UPDATE admin_sessions SET otp_challenge_id = $1 WHERE id = $2`, [
        challenge.id,
        pending.adminSessionId,
      ]);
      return challenge;
    });

    const userResult = await app.db.query<{ email: string }>(`SELECT email FROM admin_users WHERE id = $1`, [
      pending.adminUserId,
    ]);
    sendAdminOtpCode(
      request.log,
      app.config,
      { adminUserId: pending.adminUserId, email: userResult.rows[0]?.email ?? "" },
      code,
    );

    const responseBody: Record<string, unknown> = { otpRequired: true, otpExpiresAt: expiresAt.toISOString() };
    if (app.config.otpDevExpose) {
      responseBody.devOtpCode = code;
    }
    reply.code(200).send(responseBody);
  });

  app.get("/me", { preHandler: requireAdminSession }, async (request: FastifyRequest) => {
    const auth = request.adminAuth;
    if (!auth) {
      throw new UnauthorizedError("unauthenticated");
    }
    return { adminUserId: auth.adminUserId, email: auth.email, role: auth.role };
  });

  app.post(
    "/logout",
    { preHandler: requireAdminSession },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const auth = request.adminAuth;
      if (!auth) {
        throw new UnauthorizedError("unauthenticated");
      }
      await revokeAdminSession(app.db, auth.adminSessionId);
      reply.setCookie(app.config.adminCookieName, "", {
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        secure: app.config.cookieSecure,
        maxAge: 0,
      });
      reply.code(204).send();
    },
  );
}
