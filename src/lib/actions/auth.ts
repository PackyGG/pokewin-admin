"use server";

import { redirect } from "next/navigation";
import {
  deleteSession,
  deletePendingSession,
  deleteWebauthnChallenge,
  deletePasskeyGrace,
} from "@/lib/session";

export async function logout() {
  await deleteSession();
  // SECURITY (SECURITY_AUDIT.md LOW): also clear the short-lived auth-flow
  // cookies so no signed pending-2FA / passkey-challenge token survives sign-out.
  await deletePendingSession();
  await deleteWebauthnChallenge();
  await deletePasskeyGrace();
  redirect("/login");
}
