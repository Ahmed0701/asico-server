// A site image of a villa: a JPEG or PNG photo. `uploadedBy` is null when that user was deleted.
export type VillaImageDto = {
  id: string;
  villaId: string;
  name: string;
  mime: string;
  size: number;
  uploadedBy: { id: string; name: string } | null;
  uploadedAt: string;
};

// At most this many images in one upload, and on one villa.
export const MAX_IMAGES_PER_UPLOAD = 20;
export const MAX_IMAGES_PER_VILLA = 200;
