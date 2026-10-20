import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError, forbidden, unauthorized } from '../lib/errors';
import { authenticateToken, hasRecentStepUp, type AuthDeps, type AuthUser } from './service';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the `authenticate` guard. */
    auth?: AuthUser;
  }
}

/** Members who may write (spec 7: role A). Everyone else logs in read-only. */
export const WRITABLE_MEMBER_STATUSES = ['active', 'warning'];

export function requireAuth(request: FastifyRequest): AuthUser {
  if (!request.auth) throw unauthorized();
  return request.auth;
}

export function createGuards(deps: AuthDeps) {
  /** preHandler: resolves the bearer token to a user and device, rejecting revoked ones. */
  const authenticate = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized();
    request.auth = await authenticateToken(deps, header.slice(7).trim());
  };

  /** Role C (cashier) or U (auditor). */
  const requireRole =
    (...roles: Array<'cashier' | 'auditor'>) =>
    async (request: FastifyRequest): Promise<void> => {
      const user = requireAuth(request);
      if (!user.roles.some((r) => (roles as string[]).includes(r))) throw forbidden();
    };

  /** Role A: an active or warning member. */
  const requireWritable = async (request: FastifyRequest): Promise<void> => {
    const user = requireAuth(request);
    if (!WRITABLE_MEMBER_STATUSES.includes(user.member_status)) {
      throw new AppError(403, 'auth.read_only', 'This account is read-only');
    }
  };

  /** Recent TOTP on this device (12 h). Privileged accounts must enrol first. */
  const requireStepUp = async (request: FastifyRequest): Promise<void> => {
    const user = requireAuth(request);
    if (!user.totp_enabled) {
      throw new AppError(403, 'auth.totp_enrollment_required', 'Enrol an authenticator app first');
    }
    if (!hasRecentStepUp(user, deps.clock)) {
      throw new AppError(403, 'auth.step_up_required', 'Enter your authenticator code');
    }
  };

  return { authenticate, requireRole, requireWritable, requireStepUp };
}

export type Guards = ReturnType<typeof createGuards>;
