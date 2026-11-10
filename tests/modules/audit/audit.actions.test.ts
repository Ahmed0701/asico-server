import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { t } from "../../../src/core/i18n/index.js";
import {
  ACTION_LABEL_KEYS,
  KNOWN_ACTIONS,
  LEGACY_ACTIONS,
  RETIRED_ACTION_LABEL_KEYS,
  actionCodes,
  actionLabel,
  canonicalAction,
  isAuditAction,
} from "../../../src/modules/audit/dto/actions.js";
import { ENTITY_LABEL_KEYS, NAME_FIELD } from "../../../src/modules/audit/dto/entities.js";
import en from "../../../src/core/i18n/locales/en.json" with { type: "json" };
import ar from "../../../src/core/i18n/locales/ar.json" with { type: "json" };

// Every action the application writes, in English. Adding an action means adding it here, in actions.ts and in both
// language files; the scan below fails when the code writes one that is not in the list.
const ENGLISH: Record<string, string> = {
  "area.create": "Created an area",
  "area.update": "Updated an area",
  "area.delete": "Deleted an area",
  "auth.login": "Signed in",
  "auth.logout": "Signed out",
  "auth.password_changed": "Changed their own password",
  "auth.password_reset": "Reset their password with a link",
  "auth.signup": "Signed up",
  "civil_engineer.create": "Created a civil engineer",
  "civil_engineer.update": "Updated a civil engineer",
  "civil_engineer.delete": "Deleted a civil engineer",
  "contractor.create": "Created a contractor",
  "contractor.update": "Updated a contractor",
  "contractor.delete": "Deleted a contractor",
  "contractor.import": "Imported contractors",
  "daily_labour.create": "Created a daily labour entry",
  "daily_labour.update": "Updated a daily labour entry",
  "daily_labour.delete": "Deleted a daily labour entry",
  "daily_labour.import": "Imported daily labour",
  "daily_report.create": "Created a daily report",
  "daily_report.update": "Updated a daily report",
  "daily_report.delete": "Deleted a daily report",
  "daily_report.import": "Imported daily reports",
  "elec_phase.create": "Created an electrical phase",
  "elec_phase.update": "Updated an electrical phase",
  "elec_phase.delete": "Deleted an electrical phase",
  "elec_phase.reorder": "Reordered the electrical phases",
  "electrical_engineer.create": "Created an electrical engineer",
  "electrical_engineer.update": "Updated an electrical engineer",
  "electrical_engineer.delete": "Deleted an electrical engineer",
  "export.areas": "Exported areas",
  "export.audit-logs": "Exported the audit log",
  "export.civil-engineers": "Exported civil engineers",
  "export.contractor-summary": "Exported the contractor summary",
  "export.contractors": "Exported contractors",
  "export.daily-labour": "Exported daily labour",
  "export.daily-reports": "Exported daily reports",
  "export.electrical-engineers": "Exported electrical engineers",
  "export.open-works": "Exported open works",
  "export.site-reports": "Exported site reports",
  "export.material-deliveries": "Exported material deliveries",
  "export.material-balance": "Exported the material balance",
  "export.small-works": "Exported daily small works",
  "export.villas": "Exported villas",
  "open_work.create": "Created an open work",
  "open_work.update": "Updated an open work",
  "open_work.delete": "Deleted an open work",
  "open_work.import": "Imported open works",
  "site_report.create": "Created a site report",
  "site_report.update": "Updated a site report",
  "site_report.delete": "Deleted a site report",
  "site_report.import": "Imported site reports",
  "small_work.create": "Created a daily small work",
  "small_work.update": "Updated a daily small work",
  "small_work.delete": "Deleted a daily small work",
  "small_work.import": "Imported daily small works",
  "user.create": "Created a user",
  "user.update": "Updated a user",
  "user.activate": "Activated a user",
  "user.deactivate": "Deactivated a user",
  "user.delete": "Deleted a user",
  "user.password_reset_issued": "Started a password reset for a user",
  "user.permissions_replaced": "Changed the permissions of a user",
  "user.profile_updated": "Updated their own profile",
  "villa.create": "Created a villa",
  "villa.update": "Updated a villa",
  "villa.delete": "Deleted a villa",
  "villa.progress": "Updated the progress of a phase",
  "villa.import": "Imported villas",
  "villa.mew_follow_up": "Put a villa on MEW follow up",
  "villa.mew_follow_up_undo": "Took a villa off MEW follow up",
  "villa.mew_inspection": "Put a villa on MEW inspection",
  "villa.mew_inspection_undo": "Took a villa off MEW inspection",
  "villa.mew_inspection_passed": "Checked a villa as passed MEW inspection",
  "villa.mew_inspection_passed_undo": "Took back a villa's passed MEW inspection",
  "maintenance.create": "Added a maintenance villa",
  "maintenance.update": "Updated a maintenance villa",
  "maintenance.delete": "Deleted a maintenance villa",
  "maintenance.solved": "Checked a maintenance villa as solved",
  "maintenance.solved_undo": "Took back a maintenance villa's solved",
  "factory.create": "Added a factory",
  "factory.update": "Updated a factory",
  "factory.delete": "Deleted a factory",
  "material_delivery.create": "Recorded a material delivery",
  "material_delivery.update": "Updated a material delivery",
  "material_delivery.delete": "Deleted a material delivery",
  "material_delivery.note_upload": "Uploaded a delivery note",
  "material_delivery.note_delete": "Removed a delivery note",
  "material_delivery.import": "Imported material deliveries",
  "material_item.create": "Added a material to the catalog",
  "material_item.update": "Updated a catalog material",
  "material_item.delete": "Deleted a catalog material",
  "villa.material_requirements": "Changed the materials a villa needs",
  "villa.mew_states": "Changed a villa's MEW states",
  "villa_document.upload": "Uploaded a villa document",
  "villa_document.delete": "Deleted a villa document",
};

describe("action labels", () => {
  it("knows exactly the actions of the list above", () => {
    expect(Object.keys(ACTION_LABEL_KEYS).sort()).toEqual(Object.keys(ENGLISH).sort());
    expect(Object.keys(ENGLISH)).toHaveLength(96);
  });

  it.each(Object.entries(ENGLISH))("%s reads %j in English", (code, english) => {
    expect(actionLabel(code, "en")).toBe(english);
  });

  it("every action has a label in Arabic that differs from the English one", () => {
    for (const code of Object.keys(ENGLISH)) {
      const arabic = actionLabel(code, "ar");
      expect(arabic, code).not.toBe("");
      expect(arabic, code).not.toBe(actionLabel(code, "en"));
      expect(arabic, code).not.toBe(code);
    }
  });

  it("no two actions share a label in a language (a dropdown would show the same text twice)", () => {
    for (const locale of ["en", "ar"] as const) {
      const labels = Object.keys(ENGLISH).map((code) => actionLabel(code, locale));
      expect(new Set(labels).size, locale).toBe(labels.length);
    }
  });

  it("each key is the action's own, and it exists in both language files", () => {
    for (const [code, key] of Object.entries(ACTION_LABEL_KEYS)) {
      expect(key, code).toBe(`actions.${code}`);
      expect(Object.hasOwn(en, key), `${code} in en`).toBe(true);
      expect(Object.hasOwn(ar, key), `${code} in ar`).toBe(true);
    }
  });

  it("the language files hold no action label that nothing uses", () => {
    const used = new Set<string>([
      ...Object.values(ACTION_LABEL_KEYS),
      ...Object.values(RETIRED_ACTION_LABEL_KEYS),
    ]);
    for (const key of Object.keys(en).filter((candidate) => candidate.startsWith("actions."))) {
      expect(used.has(key), key).toBe(true);
    }
  });

  it("the list of known actions is the codes, sorted", () => {
    expect([...KNOWN_ACTIONS]).toEqual(Object.keys(ENGLISH).sort());
  });

  it.each(["widget.explode", "", "Villa.Create", "constructor", "toString", "__proto__", "hasOwnProperty"])(
    "an action it does not know (%j) keeps its code as its label, in both languages",
    (code) => {
      expect(actionLabel(code, "en")).toBe(code);
      expect(actionLabel(code, "ar")).toBe(code);
      expect(isAuditAction(code)).toBe(false);
    },
  );
});

describe("actions written before the villa rename", () => {
  it.each([
    ["project.create", "villa.create"],
    ["project.update", "villa.update"],
    ["project.delete", "villa.delete"],
    ["project_file.upload", "villa_document.upload"],
    ["project_file.delete", "villa_document.delete"],
    ["export.projects", "export.villas"],
  ])("%s stands for %s, and reads like it", (legacy, current) => {
    expect(canonicalAction(legacy)).toBe(current);
    expect(actionLabel(legacy, "en")).toBe(actionLabel(current, "en"));
    expect(actionLabel(legacy, "ar")).toBe(actionLabel(current, "ar"));
    expect(actionCodes(legacy).sort()).toEqual(actionCodes(current).sort());
    expect(actionCodes(current)).toContain(legacy);
    expect(actionCodes(current)[0]).toBe(current);
  });

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"])(
    "%s is not a legacy code (names inherited from Object are no actions)",
    (code) => {
      expect(canonicalAction(code)).toBe(code);
      expect(actionCodes(code)).toEqual([code]);
    },
  );

  it("every legacy code stands for an action of today", () => {
    for (const current of Object.values(LEGACY_ACTIONS)) expect(isAuditAction(current), current).toBe(true);
    expect(Object.keys(LEGACY_ACTIONS)).toHaveLength(6);
  });

  it("an action with no legacy code is its own, alone", () => {
    expect(canonicalAction("villa.progress")).toBe("villa.progress");
    expect(actionCodes("villa.progress")).toEqual(["villa.progress"]);
    expect(actionCodes("widget.explode")).toEqual(["widget.explode"]);
  });

  it("the actions of retired features keep their code and have their own label", () => {
    expect(canonicalAction("project.material_request_update")).toBe("project.material_request_update");
    expect(actionLabel("project.material_request_update", "en")).toBe(
      "Updated a material request (a retired feature)",
    );
    expect(actionLabel("project.material_request_update", "ar")).toBe("تعديل طلب مواد (ميزة ملغاة)");
    expect(actionLabel("export.wall-piping", "en")).toBe("Exported wall piping (a retired feature)");
    expect(actionLabel("export.wall-piping", "ar")).toBe("تصدير تمديدات الجدران (ميزة ملغاة)");
    expect(isAuditAction("export.wall-piping")).toBe(false);
    // The automatic open works were removed: the entries they wrote keep their label.
    expect(actionLabel("open_work.auto_sync", "en")).toBe("Open works followed the progress (automatic)");
    expect(isAuditAction("open_work.auto_sync")).toBe(false);
    // Ready for inspection was removed too.
    expect(actionLabel("villa.ready_for_inspection", "en")).toBe("Marked a villa ready for inspection");
    expect(isAuditAction("villa.ready_for_inspection")).toBe(false);
    expect(Object.keys(RETIRED_ACTION_LABEL_KEYS).sort()).toEqual([
      "export.wall-piping",
      "open_work.auto_sync",
      "project.material_request_update",
      "villa.ready_for_inspection",
      "villa.ready_for_inspection_undo",
    ]);
  });

  it("a retired action is not offered among the known ones", () => {
    expect(KNOWN_ACTIONS).not.toContain("export.wall-piping" as never);
    expect(t("en", RETIRED_ACTION_LABEL_KEYS["export.wall-piping"])).toContain("wall piping");
  });
});

// ---- the guard: what the code writes is what is labelled ----

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "generated" ? [] : sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

const SRC = join(process.cwd(), "src");
const FILES = sourceFiles(SRC).filter(
  // The labels file names a column "Entity": a title, not an entity.
  (path) => !path.endsWith(join("audit", "dto", "actions.ts")) && !path.endsWith(join("export", "labels.ts")),
);
const LITERAL = /"([a-z][a-z_-]*(?:\.[a-z][a-z_-]*)+)"/g;
const ENTITY_LITERAL = /"([A-Z][A-Za-z]+)"/g;

// The string literals on the lines that set an action: `action: "x.y"`, `ACTION = "x.y"` (a ternary puts two on a line).
function writtenActions(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of FILES) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!/\b(?:action|ACTION)\b\s*[:=]/.test(line)) continue;
      for (const match of line.matchAll(LITERAL)) found.set(match[1]!, file);
    }
  }
  return found;
}

// The entity an entry is written about: `entity: "X"`, `entity = "X"`, `ENTITY = "X"`, and the import definitions' `table`.
function writtenEntities(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of FILES) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!/\b(?:entity|ENTITY)\b\s*[:=]/.test(line)) continue;
      for (const match of line.matchAll(ENTITY_LITERAL)) found.set(match[1]!, file);
    }
  }
  return found;
}

describe("every action and entity the code writes is labelled", () => {
  it("finds the actions the application writes (the scan itself works)", () => {
    const found = writtenActions();

    expect(found.size).toBeGreaterThan(60);
    for (const sample of [
      "villa.create",
      "auth.login",
      "export.villas",
      "contractor.import",
      "villa.mew_follow_up_undo",
    ]) {
      expect(found.has(sample), sample).toBe(true);
    }
  });

  it("no action is written without a label", () => {
    const missing = [...writtenActions()].filter(([code]) => !isAuditAction(code));

    expect(missing.map(([code, file]) => `${code} in ${file}`)).toEqual([]);
  });

  it("no label is kept for an action that is not written any more", () => {
    const written = writtenActions();
    const unused = Object.keys(ACTION_LABEL_KEYS).filter((code) => !written.has(code));

    expect(unused).toEqual([]);
  });

  it("finds the entities the application writes (the scan itself works)", () => {
    const found = writtenEntities();

    for (const sample of ["Villa", "WorkItem", "DailyLabour", "AuditLog", "User"]) {
      expect(found.has(sample), sample).toBe(true);
    }
  });

  it("no entity is written without a label and a name field", () => {
    const missing = [...writtenEntities()].filter(
      ([code]) => !Object.hasOwn(ENTITY_LABEL_KEYS, code) || !Object.hasOwn(NAME_FIELD, code),
    );

    expect(missing.map(([code, file]) => `${code} in ${file}`)).toEqual([]);
  });

  it("no entity is labelled that the code does not write", () => {
    const written = writtenEntities();

    expect(Object.keys(ENTITY_LABEL_KEYS).filter((code) => !written.has(code))).toEqual([]);
  });

  it("every entity has a name field, apart from the audit log itself", () => {
    for (const code of Object.keys(ENTITY_LABEL_KEYS)) {
      expect(Object.hasOwn(NAME_FIELD, code), code).toBe(true);
      if (code !== "AuditLog") expect(NAME_FIELD[code as keyof typeof NAME_FIELD], code).toBeTruthy();
    }
  });
});
