import { z } from "zod";
import { email, name, newPassword, required } from "../../../shared/validation/fields.js";

// Existing passwords are only compared, never re-validated against the current policy.
const existingPassword = z.string(required).min(1, required).max(1024, { error: "validation.invalid" });

const opaqueToken = z.string(required).min(1, required).max(512, { error: "validation.invalid" });

export const signupSchema = z.strictObject({ name, email, password: newPassword });
export const loginSchema = z.strictObject({ email, password: existingPassword });
export const forgotPasswordSchema = z.strictObject({ email });
export const resetPasswordSchema = z.strictObject({ token: opaqueToken, password: newPassword });
export const changePasswordSchema = z.strictObject({
  currentPassword: existingPassword,
  newPassword,
});
export const updateMeSchema = z.strictObject({ name });

export type SignupInput = z.output<typeof signupSchema>;
export type LoginInput = z.output<typeof loginSchema>;
export type ForgotPasswordInput = z.output<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.output<typeof resetPasswordSchema>;
export type ChangePasswordInput = z.output<typeof changePasswordSchema>;
export type UpdateMeInput = z.output<typeof updateMeSchema>;
