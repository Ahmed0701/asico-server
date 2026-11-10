export type Sort = {
  field: string;
  direction: "asc" | "desc";
};

export function parseSort(sort: string | undefined, allowed: readonly string[]): Sort | undefined {
  if (!sort) {
    return undefined;
  }

  const [field, direction] = sort.split(":");
  if (!field || !allowed.includes(field)) {
    return undefined;
  }

  return {
    field,
    direction: direction === "desc" ? "desc" : "asc",
  };
}
