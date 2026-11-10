import type { HealthStatusDto } from "../dto/health.dto.js";

export function toHealthDto(status: HealthStatusDto["status"]): HealthStatusDto {
  return { status };
}
