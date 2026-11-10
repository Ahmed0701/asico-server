import { HealthRepository } from "../repository/health.repository.js";

export class HealthService {
  constructor(private readonly repository = new HealthRepository()) {}

  async getStatus(): Promise<{ status: "ok" | "degraded" }> {
    const ok = await this.repository.ping();
    return { status: ok ? "ok" : "degraded" };
  }
}
