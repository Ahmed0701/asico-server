import type { Router } from "express";

// Reads the routes of the application the way the documentation lists them: the method and the path, the permission, whether
// the request takes an Idempotency-Key or an If-Match, and the schemas it is validated by. The middleware factories are
// replaced (by vi.mock, in the test) with ones that tag what they were given, so the application's own code is untouched.

export type Validated = { source: "body" | "query" | "params"; schema: unknown };

export type Tag = {
  auth?: true;
  permission?: string;
  idempotency?: "required" | "optional";
  ifMatch?: "required" | "optional";
  validated?: Validated;
};

type Tagged = ((...args: unknown[]) => unknown) & { __docs?: Tag };

export type RouteInfo = {
  method: string;
  path: string;
  // The name of the last handler (the controller's method), which says what the route does.
  handler: string;
  auth: boolean;
  permission: string | undefined;
  idempotency: "required" | "optional" | undefined;
  ifMatch: "required" | "optional" | undefined;
  validated: Validated[];
};

const passThrough = (): Tagged => {
  const middleware: Tagged = (...args: unknown[]) => (args[2] as () => void)();
  return middleware;
};

export function tagged(tag: Tag): Tagged {
  return Object.assign(passThrough(), { __docs: tag });
}

// The replacements, one per factory.
export const fakes = {
  auth: () => tagged({ auth: true }),
  requirePermission: (permission: string) => tagged({ permission }),
  idempotent: (options?: { required?: boolean }) =>
    tagged({ idempotency: options?.required === true ? "required" : "optional" }),
  ifMatch: (options?: { required?: boolean }) =>
    tagged({ ifMatch: options?.required === true ? "required" : "optional" }),
  validate: (schema: unknown, source: Validated["source"] = "body") =>
    tagged({ validated: { source, schema } }),
};

type Layer = {
  route?: { path: string; methods: Record<string, boolean>; stack: { handle: Tagged }[] };
  handle: { stack?: Layer[] } & Tagged;
};

export function collectRoutes(router: Router, prefix = ""): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const walk = (layers: Layer[]): void => {
    for (const layer of layers) {
      if (layer.route) {
        const { route } = layer;
        const handlers = route.stack.map((entry) => entry.handle);
        const tags = handlers.map((handler) => handler.__docs).filter((tag): tag is Tag => tag !== undefined);
        const pick = <Key extends keyof Tag>(key: Key): Tag[Key] | undefined =>
          tags.find((tag) => tag[key] !== undefined)?.[key];
        for (const method of Object.keys(route.methods)) {
          routes.push({
            method: method.toUpperCase(),
            path: `${prefix}${route.path}`,
            handler: handlers.at(-1)?.name ?? "",
            auth: tags.some((tag) => tag.auth === true),
            permission: pick("permission"),
            idempotency: pick("idempotency"),
            ifMatch: pick("ifMatch"),
            validated: tags.flatMap((tag) => (tag.validated ? [tag.validated] : [])),
          });
        }
      } else if (layer.handle.stack) {
        walk(layer.handle.stack);
      }
    }
  };
  walk((router as unknown as { stack: Layer[] }).stack);
  return routes;
}
