import { Router } from "express";
import { env } from "../../../core/config/env.js";
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

export const authRouter = Router();

authRouter.post("/auth/signup", limited(), validate(signupSchema), controller.signup);
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
