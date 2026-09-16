-- Rend la propriété d'un partage intrinsèque plutôt que déduite de ses fichiers.
--
-- Sans cette colonne, un lien à usage unique disparaîtrait de la liste de son
-- créateur au moment où ses fichiers sont effacés — c'est-à-dire précisément
-- quand celui-ci veut vérifier que le transfert a bien eu lieu.
--
-- La colonne est ajoutée en trois temps pour ne pas perdre les partages
-- existants : d'abord nullable, puis remplie depuis le propriétaire des
-- fichiers couverts, et seulement ensuite rendue obligatoire.

-- 1. Ajout sans contrainte, pour que les lignes existantes restent valides.
ALTER TABLE "shares" ADD COLUMN "owner_id" UUID;

-- 2. Reprise de l'existant : le créateur d'un partage est le propriétaire des
--    fichiers qu'il couvre.
UPDATE "shares" AS s
SET "owner_id" = (
  SELECT f."owner_id"
  FROM "share_files" sf
  JOIN "files" f ON f."id" = sf."file_id"
  WHERE sf."share_id" = s."id"
  LIMIT 1
)
WHERE s."owner_id" IS NULL;

-- 3. Les partages qui ne couvrent plus aucun fichier n'ont pas de propriétaire
--    identifiable : ils ne servent plus à rien et sont retirés.
DELETE FROM "shares" WHERE "owner_id" IS NULL;

-- 4. La colonne devient obligatoire.
ALTER TABLE "shares" ALTER COLUMN "owner_id" SET NOT NULL;

CREATE INDEX "shares_owner_id_idx" ON "shares"("owner_id");

ALTER TABLE "shares" ADD CONSTRAINT "shares_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
