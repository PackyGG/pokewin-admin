const IMAGEKIT_PUBLIC_KEY = "public_lS39S3O5jxxdHwDOfOON7HM/cBA=";

export async function uploadImageClient(
  file: File,
  folder: string,
): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("File must be an image");
  if (file.size > 20 * 1024 * 1024) throw new Error("File must be under 20MB");

  // Get auth params from our server
  const authRes = await fetch("/api/imagekit-auth");
  if (!authRes.ok) throw new Error("Failed to authenticate for upload");
  const { token, expire, signature } = await authRes.json();

  // Upload directly to ImageKit
  const formData = new FormData();
  formData.append("file", file);
  formData.append("publicKey", IMAGEKIT_PUBLIC_KEY);
  formData.append("signature", signature);
  formData.append("expire", String(expire));
  formData.append("token", token);
  formData.append("fileName", file.name);
  formData.append("folder", folder);

  const uploadRes = await fetch("https://upload.imagekit.io/api/v1/files/upload", {
    method: "POST",
    body: formData,
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`Upload failed: ${err}`);
  }

  const data = await uploadRes.json();
  return data.url;
}
