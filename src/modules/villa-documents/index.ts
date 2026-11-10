export { villaDocumentsRouter } from "./routes/villa-documents.routes.js";

// What other modules may use: deleting a villa removes its folder from disk.
export { removeVillaDocuments } from "./service/remove-villa-documents.js";
