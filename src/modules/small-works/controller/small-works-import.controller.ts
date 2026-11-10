import type { Request, Response } from "express";
import { AppError } from "../../../core/errors/AppError.js";
import { t } from "../../../core/i18n/index.js";
import { actorOf, contextOf } from "../../../core/middleware/requestContext.js";
import { CONTENT_TYPES } from "../../../shared/export/types.js";
import type { ImportQuery } from "../../../shared/import/index.js";
import { SmallWorksImportService } from "../service/small-works-import.service.js";

export class SmallWorksImportController {
  constructor(private readonly service = new SmallWorksImportService()) {}

  // The file is English, whatever the request asked for, like an export.
  template = async (_req: Request, res: Response): Promise<void> => {
    const { fileName, bytes } = await this.service.template();
    res.status(200);
    res.setHeader("Content-Type", CONTENT_TYPES.xlsx);
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Language", "en");
    res.setHeader("Cache-Control", "private, no-store");
    res.send(bytes);
  };

  // The report is the body whatever the outcome: 201 when the rows were saved, 200 for a dry run, 422 when a row has
  // a problem. A file that cannot be read at all is an ordinary error response.
  import = async (req: Request, res: Response): Promise<void> => {
    const { file } = req;
    if (!file) {
      throw new AppError(400, t(req.locale, "import.noFile"), "NO_FILE_PROVIDED");
    }
    const { dryRun } = req.validated.query as ImportQuery;
    const { status, report } = await this.service.importFile(
      actorOf(req),
      { name: file.originalname, bytes: file.buffer },
      dryRun,
      contextOf(req),
    );
    res.status(status).json({ data: report });
  };
}
