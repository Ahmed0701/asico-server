import { randomUUID } from "node:crypto";
import type {
  Db,
  NewVillaDocument,
  StoredFileRow,
  VillaDocumentRow,
  VillaDocumentsRepository,
} from "../../../src/modules/villa-documents/repository/villa-documents.repository.js";
import { store } from "../auth/in-memory-auth.repository.js";
import { transactionLock } from "../auth/in-memory-auth.repository.js";
import { inMemoryTransaction } from "../users/in-memory-users.repository.js";
import { missingRowError, villaTables, type StoredDocument } from "../villas/in-memory-villas.repository.js";

// Documents live in the villas fake's tables (they belong to its villas, and a villa delete cascades to
// them), so this fake only adds the reads and writes of the villa-documents module.

// Uploads in a test happen within the same millisecond; keep creation times strictly increasing so "oldest
// first" is the upload order.
let lastCreated = 0;
function nextCreatedAt(): Date {
  lastCreated = Math.max(Date.now(), lastCreated + 1);
  return new Date(lastCreated);
}

export function addDocument(overrides: Partial<StoredDocument> & { villaId: string }): StoredDocument {
  const document: StoredDocument = {
    id: randomUUID(),
    storageKey: `villas/${overrides.villaId}/${randomUUID()}.pdf`,
    originalName: "plan.pdf",
    sizeBytes: 100,
    mimeType: "application/pdf",
    uploadedById: store.users[0]?.id ?? randomUUID(),
    createdAt: nextCreatedAt(),
    ...overrides,
  };
  villaTables.documents.push(document);
  return document;
}

function toRow(document: StoredDocument): VillaDocumentRow {
  return {
    id: document.id,
    villaId: document.villaId,
    originalName: document.originalName,
    sizeBytes: document.sizeBytes,
    mimeType: document.mimeType,
    createdAt: document.createdAt,
    uploadedBy: {
      id: document.uploadedById,
      name: store.users.find((u) => u.id === document.uploadedById)?.name ?? "",
    },
  };
}

const inOrder = (documents: StoredDocument[]): StoredDocument[] =>
  [...documents].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));

function runBeforeWrite(): void {
  const hook = villaTables.beforeWrite;
  villaTables.beforeWrite = null;
  hook?.();
}

export class InMemoryVillaDocumentsRepository implements VillaDocumentsRepository {
  // Transactions take turns, as they would behind a row lock (see tests/helpers/serial.ts).
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return transactionLock.run(() => this.unlockedTransaction(work));
  }

  private async unlockedTransaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    // What another request did since the service's checks; it is committed, so a rollback must not undo it.
    runBeforeWrite();
    const before = structuredClone({ documents: villaTables.documents });
    try {
      return await inMemoryTransaction(work);
    } catch (err) {
      villaTables.documents = before.documents;
      throw err;
    }
  }

  async villaExists(id: string): Promise<boolean> {
    return villaTables.villas.some((p) => p.id === id);
  }

  // Memory has no concurrent transactions to lock against; the real row lock is exercised in the dry run.
  async lockVilla(villaId: string): Promise<boolean> {
    return this.villaExists(villaId);
  }

  async countDocuments(villaId: string): Promise<number> {
    return villaTables.documents.filter((d) => d.villaId === villaId).length;
  }

  async createDocument(data: NewVillaDocument): Promise<VillaDocumentRow> {
    return toRow(addDocument({ ...data }));
  }

  async listByVilla(villaId: string): Promise<VillaDocumentRow[]> {
    return inOrder(villaTables.documents.filter((d) => d.villaId === villaId)).map(toRow);
  }

  async findStored(id: string): Promise<StoredFileRow | null> {
    const document = villaTables.documents.find((d) => d.id === id);
    return document ? { ...toRow(document), storageKey: document.storageKey } : null;
  }

  async deleteDocument(id: string): Promise<void> {
    if (!villaTables.documents.some((d) => d.id === id)) throw missingRowError();
    villaTables.documents = villaTables.documents.filter((d) => d.id !== id);
  }
}
