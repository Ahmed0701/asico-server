import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { env } from "../../../core/config/env.js";
import { setVersionHeaders } from "../../../core/concurrency/version.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t } from "../../../core/i18n/index.js";
import { actorOf, contextOf } from "../../../core/middleware/requestContext.js";
import { downloadMode, toUploadError } from "../../villa-documents/controller/villa-documents.controller.js";
import { toContentDisposition } from "../../villa-documents/mapper/villa-documents.mapper.js";
import { MAX_NOTES } from "../dto/materials.dto.js";
import { DeliveriesService } from "../service/deliveries.service.js";
import { FactoriesService } from "../service/factories.service.js";
import { ItemsService } from "../service/items.service.js";
import type {
  CreateDeliveryInput,
  CreateFactoryInput,
  CreateItemInput,
  ListBalanceQuery,
  ListItemsQuery,
  UpdateItemInput,
  VillaRequirementsInput,
  ListDeliveriesQuery,
  ListFactoriesQuery,
  UpdateDeliveryInput,
  UpdateFactoryInput,
} from "../validators/materials.validators.js";

const PROTECTED_PREFIX = "/protected-files/";

function idOf(req: Request): string {
  return (req.validated.params as { id: string }).id;
}

export class MaterialsController {
  constructor(
    private readonly factories = new FactoriesService(),
    private readonly deliveries = new DeliveriesService(),
    private readonly items = new ItemsService(),
  ) {}

  // ---- the catalog of materials ----

  listItems = async (req: Request, res: Response): Promise<void> => {
    res.status(200).json({ data: await this.items.list(req.validated.query as ListItemsQuery) });
  };

  createItem = async (req: Request, res: Response): Promise<void> => {
    const item = await this.items.create(actorOf(req), req.body as CreateItemInput, contextOf(req));
    setVersionHeaders(res, item.version);
    res.status(201).json({ data: item });
  };

  updateItem = async (req: Request, res: Response): Promise<void> => {
    const item = await this.items.update(
      actorOf(req),
      idOf(req),
      req.body as UpdateItemInput,
      contextOf(req),
      req.expectedVersion,
    );
    setVersionHeaders(res, item.version);
    res.status(200).json({ data: item });
  };

  removeItem = async (req: Request, res: Response): Promise<void> => {
    await this.items.remove(actorOf(req), idOf(req), contextOf(req), req.expectedVersion);
    res.status(204).end();
  };

  // ---- the balance ----

  balance = async (req: Request, res: Response): Promise<void> => {
    const { items, meta, totals } = await this.deliveries.balanceList(
      req.validated.query as ListBalanceQuery,
    );
    res.status(200).json({ data: items, meta, totals });
  };

  setRequirements = async (req: Request, res: Response): Promise<void> => {
    const summary = await this.deliveries.setRequirements(
      actorOf(req),
      idOf(req),
      req.body as VillaRequirementsInput,
      contextOf(req),
    );
    res.status(200).json({ data: summary });
  };

  // ---- factories ----

  listFactories = async (req: Request, res: Response): Promise<void> => {
    res.status(200).json({ data: await this.factories.list(req.validated.query as ListFactoriesQuery) });
  };

  createFactory = async (req: Request, res: Response): Promise<void> => {
    const factory = await this.factories.create(actorOf(req), req.body as CreateFactoryInput, contextOf(req));
    setVersionHeaders(res, factory.version);
    res.status(201).json({ data: factory });
  };

  updateFactory = async (req: Request, res: Response): Promise<void> => {
    const factory = await this.factories.update(
      actorOf(req),
      idOf(req),
      req.body as UpdateFactoryInput,
      contextOf(req),
      req.expectedVersion,
    );
    setVersionHeaders(res, factory.version);
    res.status(200).json({ data: factory });
  };

  removeFactory = async (req: Request, res: Response): Promise<void> => {
    await this.factories.remove(actorOf(req), idOf(req), contextOf(req), req.expectedVersion);
    res.status(204).end();
  };

  // ---- deliveries ----

  list = async (req: Request, res: Response): Promise<void> => {
    const { items, meta } = await this.deliveries.list(req.validated.query as ListDeliveriesQuery);
    res.status(200).json({ data: items, meta });
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const delivery = await this.deliveries.get(idOf(req), contextOf(req));
    setVersionHeaders(res, delivery.version);
    res.status(200).json({ data: delivery });
  };

  summary = async (req: Request, res: Response): Promise<void> => {
    res.status(200).json({ data: await this.deliveries.summary(idOf(req), contextOf(req)) });
  };

  create = async (req: Request, res: Response): Promise<void> => {
    const delivery = await this.deliveries.create(
      actorOf(req),
      req.body as CreateDeliveryInput,
      contextOf(req),
    );
    setVersionHeaders(res, delivery.version);
    res.status(201).json({ data: delivery });
  };

  update = async (req: Request, res: Response): Promise<void> => {
    const delivery = await this.deliveries.update(
      actorOf(req),
      idOf(req),
      req.body as UpdateDeliveryInput,
      contextOf(req),
      req.expectedVersion,
    );
    setVersionHeaders(res, delivery.version);
    res.status(200).json({ data: delivery });
  };

  remove = async (req: Request, res: Response): Promise<void> => {
    await this.deliveries.remove(actorOf(req), idOf(req), contextOf(req), req.expectedVersion);
    res.status(204).end();
  };

  // ---- the delivery note files ----

  // Receives up to MAX_NOTES files, all named "file", into temp paths inside the upload folder; text fields are refused.
  receiveNotes = (req: Request, res: Response, next: NextFunction): void => {
    const upload = multer({
      storage: multer.diskStorage({
        destination: (_req, _file, done) => {
          this.deliveries
            .tempDir()
            .then((dir) => void done(null, dir))
            .catch((err: unknown) => done(err as Error, ""));
        },
        filename: (_req, _file, done) => done(null, `${randomUUID()}.upload`),
      }),
      limits: { fileSize: env.MAX_UPLOAD_BYTES, files: MAX_NOTES, fields: 0 },
      defParamCharset: "utf8",
    }).array("file", MAX_NOTES);
    upload(req, res, (err?: unknown) => next(err ? toUploadError(err, req.locale) : undefined));
  };

  uploadNotes = async (req: Request, res: Response): Promise<void> => {
    const files = Array.isArray(req.files) ? req.files : [];
    if (files.length === 0) {
      throw new AppError(400, t(req.locale, "errors.deliveryNoteMissing"), "NO_FILE_PROVIDED");
    }
    const delivery = await this.deliveries.uploadNotes(
      actorOf(req),
      idOf(req),
      files.map((file) => ({ tempPath: file.path, originalName: file.originalname })),
      contextOf(req),
    );
    setVersionHeaders(res, delivery.version);
    res.status(201).json({ data: delivery });
  };

  removeNote = async (req: Request, res: Response): Promise<void> => {
    const { id, noteId } = req.validated.params as { id: string; noteId: string };
    const delivery = await this.deliveries.removeNote(actorOf(req), id, noteId, contextOf(req));
    setVersionHeaders(res, delivery.version);
    res.status(200).json({ data: delivery });
  };

  // One delivery note file, shown in the browser (inline). Streamed by this process or handed to nginx, like the villa
  // documents (see downloadMode).
  note = async (req: Request, res: Response): Promise<void> => {
    const ctx = contextOf(req);
    const { id, noteId } = req.validated.params as { id: string; noteId: string };
    const file = await this.deliveries.noteFile(id, noteId, ctx);
    const headers = () => {
      res.status(200);
      res.setHeader("Content-Type", file.mime);
      res.setHeader("Content-Disposition", toContentDisposition(file.name, "inline"));
      res.setHeader("Content-Language", "en");
      res.setHeader("Cache-Control", "private, no-store");
    };
    if (downloadMode() === "stream") {
      const { stream, size } = await this.deliveries.openNote(file.key, ctx);
      headers();
      res.setHeader("Content-Length", size);
      await pipeline(stream, res).catch(() => res.destroy());
      return;
    }
    headers();
    res.setHeader("X-Accel-Redirect", `${PROTECTED_PREFIX}${file.key}`);
    res.status(200).end();
  };
}
