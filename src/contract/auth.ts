/**
 * API §4.3: registration, login, sessions.
 *
 * The order of checks of `POST /auth/register` is mode → PoW → schema → login → taken → password policy (DESIGN §4.2),
 * so the route checks `pow` before this schema; a new password is not limited here ({@link NewPassword}).
 */
import { z } from "zod";
import {
  CheckedPassword,
  DeviceDto,
  DeviceInput,
  DevicePatch,
  IntOut,
  IsoOut,
  Login,
  NewPassword,
  optional,
  POW_CHALLENGE_MAX_LENGTH,
  POW_CHALLENGE_PATTERN,
  PowChallenge,
  PowNonce,
  RefreshToken,
  TokenPair,
  UserDto,
  UuidOut,
} from "./common.ts";

export const RegisterChallenge = z
  .object({
    challenge: z.string().meta({
      maxLength: POW_CHALLENGE_MAX_LENGTH,
      pattern: POW_CHALLENGE_PATTERN.source,
      description: "`mgpow1.<b64url>.<b64url>`, single use, TTL 10 min.",
    }),
    bits: IntOut.meta({ description: "Leading zero bits required of sha256(challenge + ':' + nonce)." }),
    expiresAt: IsoOut,
  })
  .meta({ id: "RegisterChallenge" });

export const PowSolution = z.object({ challenge: PowChallenge, nonce: PowNonce }).meta({ id: "PowSolution" });

export const RegisterRequest = z
  .object({
    login: Login,
    password: NewPassword,
    device: DeviceInput,
    pow: optional(PowSolution),
  })
  .meta({ id: "RegisterRequest" });

export const LoginRequest = z
  .object({
    login: Login,
    password: CheckedPassword,
    device: DeviceInput,
  })
  .meta({ id: "LoginRequest" });

export const RefreshRequest = z
  .object({
    refreshToken: RefreshToken,
    device: DevicePatch,
  })
  .meta({ id: "RefreshRequest" });

export const RefreshResponse = z
  .object({
    tokens: TokenPair,
    device: DeviceDto,
    serverId: UuidOut,
    serverTime: IsoOut,
  })
  .meta({ id: "RefreshResponse" });

export const LogoutRequest = z
  .object({ refreshToken: RefreshToken })
  .meta({ id: "LogoutRequest", description: "Always answers 204 (API §4.3)." });

export const MeResponse = z
  .object({
    user: UserDto,
    device: DeviceDto,
    serverId: UuidOut,
    serverTime: IsoOut,
  })
  .meta({ id: "MeResponse" });

export type RegisterChallenge = z.output<typeof RegisterChallenge>;
export type PowSolution = z.output<typeof PowSolution>;
export type RegisterRequest = z.output<typeof RegisterRequest>;
export type LoginRequest = z.output<typeof LoginRequest>;
export type RefreshRequest = z.output<typeof RefreshRequest>;
export type RefreshResponse = z.output<typeof RefreshResponse>;
export type LogoutRequest = z.output<typeof LogoutRequest>;
export type MeResponse = z.output<typeof MeResponse>;
