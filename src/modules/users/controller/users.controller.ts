import type { Request, Response } from "express";
import { setVersionHeaders } from "../../../core/concurrency/version.js";
import { t } from "../../../core/i18n/index.js";
import { actorOf, contextOf } from "../../../core/middleware/requestContext.js";
import { UsersService } from "../service/users.service.js";
import type { CreateUserInput, ListUsersQuery, UpdateUserInput } from "../validators/users.validators.js";

function idOf(req: Request): string {
  return (req.validated.params as { id: string }).id;
}

export class UsersController {
  constructor(private readonly service = new UsersService()) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const { users, meta } = await this.service.list(req.validated.query as ListUsersQuery);
    res.status(200).json({ data: users, meta });
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const user = await this.service.get(idOf(req), contextOf(req));
    setVersionHeaders(res, user.version);
    res.status(200).json({ data: user });
  };

  create = async (req: Request, res: Response): Promise<void> => {
    const user = await this.service.create(actorOf(req), req.body as CreateUserInput, contextOf(req));
    res.status(201).json({ data: user });
  };

  update = async (req: Request, res: Response): Promise<void> => {
    const user = await this.service.update(
      actorOf(req),
      idOf(req),
      req.body as UpdateUserInput,
      contextOf(req),
      req.expectedVersion,
    );
    setVersionHeaders(res, user.version);
    res.status(200).json({ data: user });
  };

  activate = async (req: Request, res: Response): Promise<void> => {
    const user = await this.service.activate(actorOf(req), idOf(req), contextOf(req), req.expectedVersion);
    setVersionHeaders(res, user.version);
    res.status(200).json({ data: user });
  };

  resetPassword = async (req: Request, res: Response): Promise<void> => {
    await this.service.resetPassword(actorOf(req), idOf(req), contextOf(req));
    res.status(200).json({ data: { message: t(req.locale, "users.passwordResetSent") } });
  };

  remove = async (req: Request, res: Response): Promise<void> => {
    await this.service.remove(actorOf(req), idOf(req), contextOf(req), req.expectedVersion);
    res.status(204).end();
  };

  deactivate = async (req: Request, res: Response): Promise<void> => {
    const user = await this.service.deactivate(actorOf(req), idOf(req), contextOf(req), req.expectedVersion);
    setVersionHeaders(res, user.version);
    res.status(200).json({ data: user });
  };
}
