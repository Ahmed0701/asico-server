import type { AreaDto, AreaOptionDto } from "../dto/areas.dto.js";
import type { AreaRow } from "../repository/areas.repository.js";

export function toAreaDto(row: AreaRow): AreaDto {
  return {
    id: row.id,
    name: row.name,
    city: row.city,
    villaCount: row._count.villas,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toOptionDto(row: { id: string; name: string; city: string }): AreaOptionDto {
  return { id: row.id, name: row.name, city: row.city };
}
