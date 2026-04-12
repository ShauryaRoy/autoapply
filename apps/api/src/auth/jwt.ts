import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { env } from "../config/env.js";

export interface AuthClaims {
  sub: string;
  email: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
}

export function signAccessToken(claims: AuthClaims): string {
  return jwt.sign(claims, env.jwtSecret, { expiresIn: "7d" });
}

export function authRequired(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ message: "Missing bearer token" });
    return;
  }

  const token = header.slice(7);

  try {
    const claims = jwt.verify(token, env.jwtSecret) as AuthClaims;
    req.user = {
      id: claims.sub,
      email: claims.email
    };
    next();
  } catch {
    res.status(401).json({ message: "Invalid token" });
  }
}
