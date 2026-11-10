-- The catalog is kept by hand: the materials an earlier migration put in are taken out again. One that a delivery
-- already has stays (its lines need it); a villa's own quantities of the others go with them (ON DELETE CASCADE).
DELETE FROM "MaterialItem" i
WHERE i."type" = 'SWITCHGEAR'
  AND i."name" IN ('Cut-out Box', 'MSB Box', 'MSB Interior', 'DB Enclosure', 'DB Interior', 'AC Box', 'AC Interior', 'AVA Box', 'Draw Box')
  AND NOT EXISTS (SELECT 1 FROM "MaterialDeliveryLine" l WHERE l."itemId" = i."id");
