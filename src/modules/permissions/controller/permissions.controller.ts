import type { Request, Response } from "express";
import { actorOf, contextOf } from "../../../core/middleware/requestContext.js";
import { PermissionsService } from "../service/permissions.service.js";
import type { ReplacePermissionsInput } from "../validators/permissions.validators.js";

function userIdOf(req: Request): string {
  return (req.validated.params as { id: string }).id;
}

export class PermissionsController {
  constructor(private readonly service = new PermissionsService()) {}

  list = async (_req: Request, res: Response): Promise<void> => {
    res.status(200).json({ data: await this.service.list() });
  };

  getForUser = async (req: Request, res: Response): Promise<void> => {
    res.status(200).json({ data: await this.service.getForUser(userIdOf(req), contextOf(req)) });
  };

  replaceForUser = async (req: Request, res: Response): Promise<void> => {
    const { permissions } = req.body as ReplacePermissionsInput;
    const result = await this.service.replaceForUser(
      actorOf(req),
      userIdOf(req),
      permissions,
      contextOf(req),
    );
    res.status(200).json({ data: result });
  };
}
