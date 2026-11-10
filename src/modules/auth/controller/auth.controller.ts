import type { CookieOptions, Request, Response } from "express";
import { env } from "../../../core/config/env.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t } from "../../../core/i18n/index.js";
import type { RefreshCookie, RequestContext } from "../dto/auth.dto.js";
import { AuthService } from "../service/auth.service.js";
import type {
  ChangePasswordInput,
  ForgotPasswordInput,
  LoginInput,
  ResetPasswordInput,
  SignupInput,
  UpdateMeInput,
} from "../validators/auth.validators.js";

export const REFRESH_COOKIE = "refresh_token";
// Scoped to the auth endpoints, so the browser never sends the refresh token anywhere else.
const REFRESH_COOKIE_PATH = "/api/v1/auth";

// The refresh answers after which the cookie is useless.
const COOKIE_REJECTED: ReadonlySet<string> = new Set([
  "INVALID_REFRESH_TOKEN",
  "ACCOUNT_INACTIVE",
  "REFRESH_TOKEN_REUSED",
]);

// Read per request, not at import time, so the environment decides when the cookie is set. Setting and clearing use the
// same options (the browser removes a cookie only when its attributes match), and the domain is left out unless it is set.
function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: env.REFRESH_COOKIE_SAMESITE,
    secure: env.REFRESH_COOKIE_SECURE ?? env.NODE_ENV !== "development",
    path: REFRESH_COOKIE_PATH,
    ...(env.REFRESH_COOKIE_DOMAIN !== undefined && { domain: env.REFRESH_COOKIE_DOMAIN }),
  };
}

function setRefreshCookie(res: Response, refresh: RefreshCookie): void {
  res.cookie(REFRESH_COOKIE, refresh.token, { ...cookieOptions(), expires: refresh.expiresAt });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, cookieOptions());
}

function refreshCookieOf(req: Request): string | undefined {
  const value: unknown = req.cookies?.[REFRESH_COOKIE];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function contextOf(req: Request): RequestContext {
  return { locale: req.locale, ip: req.ip, userAgent: req.get("user-agent"), requestId: req.requestId };
}

function userIdOf(req: Request): string {
  if (!req.user) {
    throw new AppError(401, t(req.locale, "errors.unauthorized"), "UNAUTHORIZED");
  }
  return req.user.id;
}

export class AuthController {
  constructor(private readonly service = new AuthService()) {}

  signup = async (req: Request, res: Response): Promise<void> => {
    const user = await this.service.signup(req.body as SignupInput, contextOf(req));
    res.status(201).json({ data: { user, message: t(req.locale, "auth.signupPending") } });
  };

  login = async (req: Request, res: Response): Promise<void> => {
    const { body, refresh } = await this.service.login(req.body as LoginInput, contextOf(req));
    setRefreshCookie(res, refresh);
    res.status(200).json({ data: body });
  };

  refresh = async (req: Request, res: Response): Promise<void> => {
    try {
      const { body, refresh } = await this.service.refresh(refreshCookieOf(req), contextOf(req));
      setRefreshCookie(res, refresh);
      res.status(200).json({ data: body });
    } catch (err) {
      // Only a cookie the server has judged dead is removed. A conflict (another request just rotated it), a
      // database failure or anything unexpected leaves it in place: the session may well be fine, and deleting
      // the cookie is what turns a hiccup into a logout.
      if (err instanceof AppError && COOKIE_REJECTED.has(err.code)) {
        clearRefreshCookie(res);
      }
      throw err;
    }
  };

  logout = async (req: Request, res: Response): Promise<void> => {
    await this.service.logout(refreshCookieOf(req), contextOf(req));
    clearRefreshCookie(res);
    res.status(204).end();
  };

  forgotPassword = async (req: Request, res: Response): Promise<void> => {
    await this.service.forgotPassword(req.body as ForgotPasswordInput, contextOf(req));
    res.status(200).json({ data: { message: t(req.locale, "auth.forgotPasswordSent") } });
  };

  resetPassword = async (req: Request, res: Response): Promise<void> => {
    await this.service.resetPassword(req.body as ResetPasswordInput, contextOf(req));
    clearRefreshCookie(res);
    res.status(200).json({ data: { message: t(req.locale, "auth.passwordReset") } });
  };

  changePassword = async (req: Request, res: Response): Promise<void> => {
    await this.service.changePassword(
      userIdOf(req),
      refreshCookieOf(req),
      req.body as ChangePasswordInput,
      contextOf(req),
    );
    res.status(200).json({ data: { message: t(req.locale, "auth.passwordChanged") } });
  };

  getMe = async (req: Request, res: Response): Promise<void> => {
    res.status(200).json({ data: await this.service.getMe(userIdOf(req), contextOf(req)) });
  };

  updateMe = async (req: Request, res: Response): Promise<void> => {
    const user = await this.service.updateMe(userIdOf(req), req.body as UpdateMeInput, contextOf(req));
    res.status(200).json({ data: user });
  };
}
