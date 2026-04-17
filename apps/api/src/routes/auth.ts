import { Router, type Request, type Response, type NextFunction } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { signAccessToken, authRequired } from "../auth/jwt.js";
import { encryptString, decryptString } from "../security/encryption.js";

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

      const existing = await prisma.user.findUnique({ where: { email: input.email } });
      if (existing) {
        res.status(409).json({ message: "An account with this email already exists" });
        return;
      }

      const passwordHash = await bcrypt.hash(input.password, 12);
      const user = await prisma.user.create({
        data: {
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

  router.get("/me", authRequired, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
      if (!user) {
        res.status(404).json({ message: "User not found" });
        return;
      }
      res.json({ id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName });
    } catch (error) {
      next(error);
    }
  });

  router.post("/credentials", authRequired, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;
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

  router.get("/credentials/:provider", authRequired, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;

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
