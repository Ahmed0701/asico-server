-- The material request (MR) date and the purchase order (PO) date of a material delivery: both optional.

ALTER TABLE "MaterialDelivery" ADD COLUMN "mrDate" DATE;
ALTER TABLE "MaterialDelivery" ADD COLUMN "poDate" DATE;
