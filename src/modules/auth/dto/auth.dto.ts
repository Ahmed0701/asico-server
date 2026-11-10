import type { Role } from "../../../generated/prisma/client.js";
import type { LocaleCode } from "../../../shared/constants/enums.js";

export type UserDto = {
  id: string;
  name: string;
  email: string;
  role: Role;
  isActive: boolean;
  version: number;
  createdAt: string;
};

export type MeDto = UserDto & { permissions: string[] };

export type AccessTokenDto = {
  accessToken: string;
  expiresIn: number;
};

export type LoginDto = AccessTokenDto & { user: UserDto };

// What the service needs to know about the request: the locale for messages, and audit metadata.
export type RequestContext = {
  locale: LocaleCode;
  ip?: string | undefined;
  userAgent?: string | undefined;
  requestId?: string | undefined;
};

// A refresh token the controller must put in the cookie. It is never part of a response body.
export type RefreshCookie = {
  token: string;
  expiresAt: Date;
};

export type LoginResult = { body: LoginDto; refresh: RefreshCookie };
export type RefreshResult = { body: AccessTokenDto; refresh: RefreshCookie };
