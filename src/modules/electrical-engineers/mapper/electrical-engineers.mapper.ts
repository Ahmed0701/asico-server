import type { ElectricalEngineerDto, ElectricalEngineerOptionDto } from "../dto/electrical-engineers.dto.js";
import type { ElectricalEngineerRow } from "../repository/electrical-engineers.repository.js";

export function toElectricalEngineerDto(row: ElectricalEngineerRow): ElectricalEngineerDto {
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

export function toOptionDto(row: { id: string; name: string }): ElectricalEngineerOptionDto {
  return { id: row.id, name: row.name };
}
