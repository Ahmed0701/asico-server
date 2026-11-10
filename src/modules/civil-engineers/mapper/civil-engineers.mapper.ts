import type { CivilEngineerDto, CivilEngineerOptionDto } from "../dto/civil-engineers.dto.js";
import type { CivilEngineerRow } from "../repository/civil-engineers.repository.js";

export function toCivilEngineerDto(row: CivilEngineerRow): CivilEngineerDto {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    status: row.status,
    villaCount: row._count.villas,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toOptionDto(row: { id: string; name: string }): CivilEngineerOptionDto {
  return { id: row.id, name: row.name };
}
