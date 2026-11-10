export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function prismaErrorCode(err: unknown): string | undefined {
  return isRecord(err) && typeof err.code === "string" ? err.code : undefined;
}

// P2003: a foreign key blocked the write, for example deleting a row that another table still references.
export function isForeignKeyViolation(err: unknown): boolean {
  return prismaErrorCode(err) === "P2003";
}

// P2025: the row the write targeted no longer exists, for example because it was deleted a moment earlier.
export function isRecordNotFound(err: unknown): boolean {
  return prismaErrorCode(err) === "P2025";
}

// The constraint a failed write ran into. With the pg driver adapter it is reported under
// meta.driverAdapterError.cause.constraint (an index name, or a list of fields); other setups use meta.target.
// Returns "" when the error carries no usable detail.
function constraintOf(err: unknown): string {
  if (!isRecord(err) || !isRecord(err.meta)) {
    return "";
  }
  const adapterError = err.meta.driverAdapterError;
  const cause = isRecord(adapterError) ? adapterError.cause : undefined;
  const constraint = isRecord(cause) ? cause.constraint : undefined;
  if (isRecord(constraint)) {
    if (typeof constraint.index === "string") {
      return constraint.index;
    }
    if (Array.isArray(constraint.fields)) {
      return constraint.fields.join("_");
    }
  }
  const target = err.meta.target;
  if (typeof target === "string") {
    return target;
  }
  return Array.isArray(target) ? target.join("_") : "";
}

// P2002: the name of the unique constraint that was violated, or undefined if this is not a P2002.
export function uniqueViolationConstraint(err: unknown): string | undefined {
  return prismaErrorCode(err) === "P2002" ? constraintOf(err) : undefined;
}

// P2003: the name of the foreign key that was violated, or undefined if this is not a P2003.
export function foreignKeyConstraint(err: unknown): string | undefined {
  return prismaErrorCode(err) === "P2003" ? constraintOf(err) : undefined;
}
