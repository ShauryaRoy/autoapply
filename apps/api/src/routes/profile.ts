import { Router } from "express";
import multer from "multer";
import {
  getProfileController,
  postProfileResumeController,
  putProfileController
} from "../controllers/profileController.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 8 * 1024 * 1024
  }
});

export function createProfileRouter(): Router {
  const router = Router();

  router.get("/", getProfileController);
  router.put("/", putProfileController);
  router.post("/resume", upload.single("file"), postProfileResumeController);

  return router;
}
