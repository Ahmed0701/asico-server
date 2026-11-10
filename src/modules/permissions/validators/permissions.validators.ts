import { z } from "zod";
import { permissionCodes } from "../../../shared/validation/fields.js";

export const replacePermissionsSchema = z.strictObject({ permissions: permissionCodes });

export type ReplacePermissionsInput = z.output<typeof replacePermissionsSchema>;
