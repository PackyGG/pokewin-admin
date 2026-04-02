import ImageKit from "imagekit";

const imagekit = new ImageKit({
  publicKey: "public_lS39S3O5jxxdHwDOfOON7HM/cBA=",
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY!,
  urlEndpoint: "https://ik.imagekit.io/scrkflpgw",
});

export async function uploadImage(
  file: Buffer,
  fileName: string,
  folder: string,
): Promise<string> {
  const response = await imagekit.upload({
    file,
    fileName,
    folder,
  });
  return response.url;
}
