import { Router, type NextFunction, type Request, type Response } from "express";
import { env, signupEnabled } from "../../../core/config/env.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t } from "../../../core/i18n/index.js";
import { auth } from "../../../core/middleware/auth.js";
import { createRateLimiter, refreshRateLimiter } from "../../../core/middleware/rateLimit.js";
import { validate } from "../../../core/middleware/validate.js";
import { AuthController } from "../controller/auth.controller.js";
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  resetPasswordSchema,
  signupSchema,
  updateMeSchema,
} from "../validators/auth.validators.js";

const controller = new AuthController();

// One limiter per route, so each endpoint has its own counter per client.
const limited = () =>
  createRateLimiter({ windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS, limit: env.AUTH_RATE_LIMIT_MAX });

// With public sign-up closed (production by default), only an administrator creates users, through POST /users. Checked
// before the body is read, so a closed sign-up answers the same whatever is sent.
function signupOpen(req: Request, _res: Response, next: NextFunction): void {
  if (!signupEnabled()) {
    next(new AppError(403, t(req.locale, "errors.signupDisabled"), "SIGNUP_DISABLED"));
    return;
  }
  next();
}

export const authRouter = Router();

authRouter.post("/auth/signup", limited(), signupOpen, validate(signupSchema), controller.signup);
authRouter.post("/auth/login", limited(), validate(loginSchema), controller.login);
authRouter.post("/auth/refresh", refreshRateLimiter, controller.refresh);
authRouter.post("/auth/logout", controller.logout);
authRouter.post(
  "/auth/forgot-password",
  limited(),
  validate(forgotPasswordSchema),
  controller.forgotPassword,
);
authRouter.post("/auth/reset-password", limited(), validate(resetPasswordSchema), controller.resetPassword);
authRouter.post("/auth/change-password", auth, validate(changePasswordSchema), controller.changePassword);

authRouter.get("/me", auth, controller.getMe);
authRouter.patch("/me", auth, validate(updateMeSchema), controller.updateMe);
