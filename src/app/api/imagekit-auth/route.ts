import { NextResponse } from "next/server";
import ImageKit from "imagekit";
import { requirePageAccess } from "@/lib/dal";

const imagekit = new ImageKit({
  publicKey: "public_lS39S3O5jxxdHwDOfOON7HM/cBA=",
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY!,
  urlEndpoint: "https://ik.imagekit.io/scrkflpgw",
});

export async function GET() {
  await requirePageAccess("/packs");
  const authParams = imagekit.getAuthenticationParameters();
  return NextResponse.json(authParams);
}
