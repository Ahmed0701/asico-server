import type { Request, Response } from "express";
import { toHealthDto } from "../mapper/health.mapper.js";
import { HealthService } from "../service/health.service.js";

export class HealthController {
  constructor(private readonly service = new HealthService()) {}

  getStatus = async (_req: Request, res: Response): Promise<void> => {
    const result = await this.service.getStatus();
    res.status(result.status === "ok" ? 200 : 503).json(toHealthDto(result.status));
  };
}
