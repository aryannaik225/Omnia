"use client";
/**
 * Profile pictures are compressed on the device before upload: center-cropped to 256×256 and
 * encoded as WebP (~30–50 KB), so only a tiny file reaches Storage and only its URL is stored in
 * `profiles.avatar_url`. Browsers that can't encode WebP from a canvas fall back to JPEG.
 */
export const AVATAR_SIZE = 256;
const TARGET_BYTES = 50 * 1024;
const MAX_INPUT_BYTES = 20 * 1024 * 1024;

async function decode(file: Blob): Promise<CanvasImageSource & { width: number; height: number }> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      // Fall through to <img> (e.g. formats createImageBitmap rejects).
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return Object.assign(img, { width: img.naturalWidth, height: img.naturalHeight });
  } finally {
    URL.revokeObjectURL(url);
  }
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

export async function compressAvatar(file: Blob): Promise<Blob> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
  if (file.size > MAX_INPUT_BYTES) throw new Error("That image is larger than 20 MB.");
  const image = await decode(file);
  const side = Math.min(image.width, image.height);
  if (!side) throw new Error("That image couldn't be read.");

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Your browser can't process images.");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  if ("close" in image && typeof image.close === "function") image.close();

  for (const type of ["image/webp", "image/jpeg"]) {
    let best: Blob | null = null;
    for (const q of [0.85, 0.75, 0.65, 0.5]) {
      const blob = await toBlob(canvas, type, q);
      // Safari returns PNG when it can't encode the requested type: try the next type.
      if (!blob || blob.type !== type) break;
      best = blob;
      if (blob.size <= TARGET_BYTES) return blob;
    }
    if (best) return best;
  }
  throw new Error("Your browser couldn't compress that image.");
}

/** File name in the avatars bucket for a compressed blob. */
export const avatarFileName = (blob: Blob) => (blob.type === "image/jpeg" ? "avatar.jpg" : "avatar.webp");
