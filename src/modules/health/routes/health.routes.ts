import { Router } from "express";
import { HealthController } from "../controller/health.controller.js";

const controller = new HealthController();

export const healthRouter = Router();
healthRouter.get("/health", controller.getStatus);
