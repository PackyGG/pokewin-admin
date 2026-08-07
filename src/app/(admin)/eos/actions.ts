"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { updateEosTestConfig } from "@/lib/antifraud/eos-test-config-api";
import { requireEosTestAccess } from "@/lib/eos-test-access";

export async function setUserOnlyLoses(input: unknown) {
  const session = await requireEosTestAccess();
  const userOnlyLoses = z.boolean().parse(input);
  const saved = await updateEosTestConfig({
    userOnlyLoses,
    actor: session.username,
  });
  revalidatePath("/eos");
  return saved;
}
