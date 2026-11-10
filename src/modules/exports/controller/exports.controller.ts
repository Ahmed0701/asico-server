import type { Request, Response } from "express";
import { logger } from "../../../core/config/logger.js";
import {
  actorOf,
  contextOf,
  type Actor,
  type RequestContext,
} from "../../../core/middleware/requestContext.js";
import type { ContractorSummaryQuery, ListContractorsQuery } from "../../contractors/index.js";
import type { ListAreasQuery } from "../../areas/index.js";
import type { ListAuditLogsQuery } from "../../audit/index.js";
import type { ListCivilEngineersQuery } from "../../civil-engineers/index.js";
import type { ListElectricalEngineersQuery } from "../../electrical-engineers/index.js";
import type { ListDailyLabourQuery } from "../../daily-labour/index.js";
import type { ListDailyReportsQuery } from "../../daily-reports/index.js";
import type { ListOpenWorksQuery } from "../../open-works/index.js";
import type { ListSiteReportsQuery } from "../../site-reports/index.js";
import type { ListSmallWorksQuery } from "../../small-works/index.js";
import type { ListVillasQuery } from "../../villas/index.js";
import { ExportsService, type ExportResult } from "../service/exports.service.js";
import type { ParsedExport } from "../validators/exports.validators.js";

const parsed = <Query>(req: Request): ParsedExport<Query> => req.validated.query as ParsedExport<Query>;

const HEADERS = ["Content-Type", "Content-Disposition", "Content-Language", "Cache-Control"] as const;

export class ExportsController {
  constructor(private readonly service = new ExportsService()) {}

  villas = (req: Request, res: Response) =>
    this.send(req, res, (actor, ctx) => this.service.villasExport(parsed<ListVillasQuery>(req), actor, ctx));

  openWorks = (req: Request, res: Response) =>
    this.send(req, res, (actor, ctx) =>
      this.service.openWorksExport(parsed<ListOpenWorksQuery>(req), actor, ctx),
    );

  dailyReports = (req: Request, res: Response) =>
    this.send(req, res, (actor, ctx) =>
      this.service.dailyReportsExport(parsed<ListDailyReportsQuery>(req), actor, ctx),
    );

  smallWorks = (req: Request, res: Response) =>
    this.send(req, res, (actor, ctx) =>
      this.service.smallWorksExport(parsed<ListSmallWorksQuery>(req), actor, ctx),
    );

  siteReports = (req: Request, res: Response) =>
    this.send(req, res, (actor, ctx) =>
      this.service.siteReportsExport(parsed<ListSiteReportsQuery>(req), actor, ctx),
    );

  dailyLabour = (req: Request, res: Response) =>
    this.send(req, res, (actor, ctx) =>
      this.service.dailyLabourExport(parsed<ListDailyLabourQuery>(req), actor, ctx),
    );

  contractors = (req: Request, res: Response) =>
    this.send(req, res, (actor, ctx) =>
      this.service.contractorsExport(parsed<ListContractorsQuery>(req), actor, ctx),
    );

  civilEngineers = (req: Request, res: Response) =>
    this.send(req, res, (actor, ctx) =>
      this.service.civilEngineersExport(parsed<ListCivilEngineersQuery>(req), actor, ctx),
    );

  electricalEngineers = (req: Request, res: Response) =>
    this.send(req, res, (actor, ctx) =>
      this.service.electricalEngineersExport(parsed<ListElectricalEngineersQuery>(req), actor, ctx),
    );

  areas = (req: Request, res: Response) =>
    this.send(req, res, (actor, ctx) => this.service.areasExport(parsed<ListAreasQuery>(req), actor, ctx));

  contractorSummary = (req: Request, res: Response) =>
    this.send(req, res, (actor, ctx) => {
      const { id } = req.validated.params as { id: string };
      return this.service.contractorSummaryExport(id, parsed<ContractorSummaryQuery>(req), actor, ctx);
    });

  auditLogs = (req: Request, res: Response) =>
    this.send(req, res, (actor, ctx) =>
      this.service.auditLogsExport(parsed<ListAuditLogsQuery>(req), actor, ctx),
    );

  // The count, the size check and the audit entry all happen before the first byte, so a refusal is an
  // ordinary error response. The file itself is then streamed. Content-Language is "en" whatever the
  // request asked for: the file is English. Error messages, sent by the error handler, follow the request.
  private async send(
    req: Request,
    res: Response,
    prepare: (actor: Actor, ctx: RequestContext) => Promise<ExportResult>,
  ): Promise<void> {
    const file = await prepare(actorOf(req), contextOf(req));

    res.status(200);
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
    res.setHeader("Content-Language", "en");
    res.setHeader("Cache-Control", "private, no-store");

    // A client that goes away mid-download is not an error. The writer is raced against the connection
    // closing, so a request whose client has left is never left waiting on a stream nobody reads.
    let disconnected = false;
    const closed = new Promise<never>((_, reject) => {
      res.once("close", () => {
        if (!res.writableFinished) {
          disconnected = true;
          reject(new Error("the client disconnected"));
        }
      });
    });
    closed.catch(() => undefined);

    try {
      await Promise.race([file.write(res), closed]);
    } catch (err) {
      if (disconnected) {
        logger.info({ requestId: req.requestId }, "the client disconnected during an export");
        return;
      }
      logger.error({ err, requestId: req.requestId }, "export failed while it was being written");
      if (res.headersSent) {
        // Part of a file has been sent: ending the connection is the only honest way to say it is incomplete.
        res.destroy();
        return;
      }
      for (const header of HEADERS) {
        res.removeHeader(header);
      }
      throw err;
    }
  }
}
