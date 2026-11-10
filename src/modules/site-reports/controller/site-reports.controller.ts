import type { Request, Response } from "express";
import { setVersionHeaders } from "../../../core/concurrency/version.js";
import { actorOf, contextOf } from "../../../core/middleware/requestContext.js";
import { SiteReportsService } from "../service/site-reports.service.js";
import type {
  CreateSiteReportInput,
  ListSiteReportsQuery,
  UpdateSiteReportInput,
} from "../validators/site-reports.validators.js";

function idOf(req: Request): string {
  return (req.validated.params as { id: string }).id;
}

export class SiteReportsController {
  constructor(private readonly service = new SiteReportsService()) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const { items, meta } = await this.service.list(req.validated.query as ListSiteReportsQuery);
    res.status(200).json({ data: items, meta });
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const report = await this.service.get(idOf(req), contextOf(req));
    setVersionHeaders(res, report.version);
    res.status(200).json({ data: report });
  };

  create = async (req: Request, res: Response): Promise<void> => {
    const report = await this.service.create(actorOf(req), req.body as CreateSiteReportInput, contextOf(req));
    setVersionHeaders(res, report.version);
    res.status(201).json({ data: report });
  };

  update = async (req: Request, res: Response): Promise<void> => {
    const report = await this.service.update(
      actorOf(req),
      idOf(req),
      req.body as UpdateSiteReportInput,
      contextOf(req),
      req.expectedVersion,
    );
    setVersionHeaders(res, report.version);
    res.status(200).json({ data: report });
  };

  remove = async (req: Request, res: Response): Promise<void> => {
    await this.service.remove(actorOf(req), idOf(req), contextOf(req), req.expectedVersion);
    res.status(204).end();
  };
}
