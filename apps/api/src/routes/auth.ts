import { Router, type Request, type Response, type NextFunction } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { signAccessToken, type AuthClaims } from "../auth/jwt.js";
import { encryptString, decryptString } from "../security/encryption.js";
import { env } from "../config/env.js";

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  firstName: z.string().min(1),
  lastName: z.string().min(1)
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8)
});

const CredentialSchema = z.object({
  provider: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1)
});

export function createAuthRouter(): Router {
  const router = Router();

  router.post("/register", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = RegisterSchema.parse(req.body);
      const passwordHash = await bcrypt.hash(input.password, 12);
      const user = await prisma.user.upsert({
        where: { email: input.email },
        update: {
          passwordHash,
          firstName: input.firstName,
          lastName: input.lastName
        },
        create: {
          email: input.email,
          passwordHash,
          firstName: input.firstName,
          lastName: input.lastName
        }
      });

      const token = signAccessToken({ sub: user.id, email: user.email });
      res.status(201).json({ token, userId: user.id });
    } catch (error) {
      next(error);
    }
  });

  router.post("/login", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = LoginSchema.parse(req.body);
      const user = await prisma.user.findUnique({ where: { email: input.email } });
      if (!user) {
        res.status(401).json({ message: "Invalid credentials" });
        return;
      }

      const valid = await bcrypt.compare(input.password, user.passwordHash);
      if (!valid) {
        res.status(401).json({ message: "Invalid credentials" });
        return;
      }

      const token = signAccessToken({ sub: user.id, email: user.email });
      res.json({ token, userId: user.id });
    } catch (error) {
      next(error);
    }
  });

  router.get("/me", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const header = req.headers.authorization;
      if (!header?.startsWith("Bearer ")) {
        res.status(401).json({ message: "Missing bearer token" });
        return;
      }
      const token = header.slice(7);
      const claims = jwt.verify(token, env.jwtSecret) as AuthClaims;
      const user = await prisma.user.findUnique({ where: { id: claims.sub } });
      if (!user) {
        res.status(404).json({ message: "User not found" });
        return;
      }
      res.json({ id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName });
    } catch (error) {
      next(error);
    }
  });

  router.post("/credentials", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = req.headers.authorization;
      if (!auth?.startsWith("Bearer ")) {
        res.status(401).json({ message: "Missing bearer token" });
        return;
      }

      const userId = req.headers["x-user-id"] as string | undefined;
      if (!userId) {
        res.status(400).json({ message: "x-user-id header required" });
        return;
      }

      const input = CredentialSchema.parse(req.body);
      const encryptedPassword = encryptString(input.password);

      await prisma.integrationCredential.upsert({
        where: {
          userId_provider: {
            userId,
            provider: input.provider
          }
        },
        update: {
          username: input.username,
          encryptedPassword
        },
        create: {
          userId,
          provider: input.provider,
          username: input.username,
          encryptedPassword
        }
      });

      res.status(201).json({ status: "stored" });
    } catch (error) {
      next(error);
    }
  });

  router.get("/credentials/:provider", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.headers["x-user-id"] as string | undefined;
      if (!userId) {
        res.status(400).json({ message: "x-user-id header required" });
        return;
      }

      const record = await prisma.integrationCredential.findUnique({
        where: {
          userId_provider: {
            userId,
            provider: req.params.provider
          }
        }
      });

      if (!record) {
        res.status(404).json({ message: "Credential not found" });
        return;
      }

      res.json({ provider: record.provider, username: record.username, password: decryptString(record.encryptedPassword) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
