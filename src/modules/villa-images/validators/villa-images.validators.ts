import { z } from "zod";

const uuid = z.uuid({ error: "validation.idInvalid" });

export const villaImagesParams = z.strictObject({ villaId: uuid });
export const villaImageParams = z.strictObject({ id: uuid });
