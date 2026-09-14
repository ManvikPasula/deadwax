import { fail, guard, ok, type ActionResult } from "@/app/actions/result";
import { calendarDate, signInSchema, tagList, targetTypeOf, usernameSchema, passwordSchema } from "@/lib/security/schemas";

export async function plain(): Promise<ActionResult> {
  return guard("signOut", async () => {
    if (Math.random() > 0.5) return fail("nope");
    return ok();
  });
}

export async function typed(): Promise<ActionResult<{ logId: number }>> {
  return guard("saveLog", async () => {
    if (Math.random() > 0.5) return fail("nope");
    return ok({ logId: 1 });
  });
}

// @ts-expect-error a typed action must supply data
export const bad: ActionResult<{ logId: number }> = ok();

// @ts-expect-error not an ActionLabel
export const badLabel = guard("nope", async () => ok());

export const checks = [
  usernameSchema.safeParse("admin").success,
  passwordSchema.safeParse("é".repeat(72)).success,
  signInSchema.safeParse({ email: "a@b.co", password: "x" }).success,
  calendarDate.safeParse("2026-02-30").success,
  calendarDate.safeParse("infinity").success,
  tagList.safeParse(["İ".repeat(17)]).success,
  targetTypeOf({ albumId: 3, trackNumber: 0 }) === "track",
];
