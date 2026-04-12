import type { NextFunction, Request, Response } from "express";
import pdfParse from "pdf-parse";
import {
  getProfileByUserId,
  upsertProfileByUserId,
  updateResumeTextByUserId,
  type UserProfilePayload
} from "../services/profileService.js";

function getUserId(req: Request): string | null {
  return req.user?.id ?? null;
}

export async function getProfileController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    const profile = await getProfileByUserId(userId);
    res.json(profile);
  } catch (error) {
    next(error);
  }
}

export async function putProfileController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    const profile = await upsertProfileByUserId(userId, req.body);
    res.json(profile);
  } catch (error) {
    next(error);
  }
}

async function parseResumeFromUpload(req: Request): Promise<string> {
  const body = req.body as { resumeText?: string };
  if (typeof body.resumeText === "string" && body.resumeText.trim().length > 0) {
    return body.resumeText.trim();
  }

  const file = req.file;
  if (!file) {
    return "";
  }

  const isPdf = file.mimetype === "application/pdf" || file.originalname.toLowerCase().endsWith(".pdf");
  if (!isPdf) {
    throw new Error("Only PDF uploads are supported for resume file extraction");
  }

  const result = await pdfParse(file.buffer);
  return (result.text ?? "").trim();
}

export async function postProfileResumeController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    const extractedText = await parseResumeFromUpload(req);
    if (!extractedText) {
      res.status(400).json({ message: "Provide resumeText or upload a readable PDF file" });
      return;
    }

    const profile: UserProfilePayload = await updateResumeTextByUserId(userId, extractedText);
    res.status(201).json({ resumeText: profile.resumeText });
  } catch (error) {
    next(error);
  }
}
